import type { Express, Request, Response, NextFunction } from "express";
import { Server } from "http";
import { storage, rawSqlite } from "./storage";
import { fetchStockData, applyStoredFallbacks } from "./lib/dataFetcher";
import { getFxRates, convertPrice } from "./lib/fxRates";
import { rankMultiple, STRICTNESS_PRESETS, HORIZON_WEIGHTS } from "./lib/rankingEngine";
import { extractBearer } from "./lib/jwtAuth";
import { getDiskStats, runPrune, walCheckpoint } from "./lib/diskMonitor";
import { expandUniverse } from "./lib/universeExpansion";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import {
  startScheduler,
  stopScheduler,
  runRefresh,
  getSchedulerState,
  getRefreshProgress,
  isMarketOpen,
  runInsiderBulkRefresh,
} from "./lib/scheduler";
import { insertUniverseSchema, insertWatchlistSchema } from "../shared/schema";
import { z } from "zod";
import axios from "axios";

// ─── Access-link auth middleware (two-tier: admin | viewer) ──────────────────
// Reads raw 32-char hex token from Bearer header OR ?token query param.
// Looks up token directly in access_links table (no JWT wrapper).
// Attaches req.accessLink = { id, type } on success.
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const raw =
    extractBearer(req.headers.authorization) ??
    (req.query.token as string | undefined) ??
    null;
  if (raw) {
    const link = await storage.getAccessLink(raw);
    if (link && link.isActive) {
      (req as any).accessLink = { id: link.id, type: link.type };
      storage.touchAccessLink(link.id); // best-effort, non-blocking
      return next();
    }
  }
  return res.status(401).json({ error: "Unauthorized — use your access link." });
}

// ─── Write-guard: viewer tokens cannot mutate state ──────────────────────────
async function requireWriteAuth(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, () => {
    const link = (req as any).accessLink as { id: string; type: string } | undefined;
    if (!link) return res.status(401).json({ error: "Unauthorized — use your access link." });
    if (link.type === "viewer") return res.status(403).json({ error: "This action requires admin access." });
    return next();
  });
}

// ─── Admin panel auth (password-based, SSR pages only) ───────────────────────
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const qRaw = req.query.adminToken as string | undefined;
  const bToken = req.body?.adminToken as string | undefined;
  const hToken = extractBearer(req.headers.authorization);
  const expected = process.env.ADMIN_PASSWORD;

  // Decode base64url query param (used by login redirect to avoid # truncation)
  let qToken = qRaw;
  if (qRaw && qRaw !== expected) {
    try { qToken = Buffer.from(qRaw, 'base64url').toString('utf8'); } catch { /* not base64 */ }
  }

  const provided = qToken || bToken || hToken;
  if (expected && provided === expected) {
    (req as any).adminToken = expected; // always store the real password for use in panel HTML
    return next();
  }
  // API routes: return JSON 401 so fetch() callers get a parseable error, not a redirect to HTML
  const isApiRequest = req.path.startsWith("/api/") ||
    req.headers.accept?.includes("application/json") ||
    req.headers["content-type"]?.includes("application/json");
  if (isApiRequest) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/admin/login");
}

// ─── Rate limiters ────────────────────────────────────────────────────────────
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

// ─── Structured Logger ────────────────────────────────────────────────────────

function logInfo(tag: string, msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${ts}] [INFO] [${tag}] ${msg}${extra}`);
}

function logError(tag: string, msg: string, err?: unknown) {
  const ts = new Date().toISOString();
  const errStr = err instanceof Error ? err.message + (err.stack ? "\n" + err.stack : "") : String(err ?? "");
  console.error(`[${ts}] [ERROR] [${tag}] ${msg}${errStr ? " :: " + errStr : ""}`);
}

// ─── Horizon Score (live per-request recomputation from raw factor scores) ────
// Re-implements the per-horizon weighting from rankingEngine's HORIZON_WEIGHTS
// so the /api/recommendations endpoint can re-rank stored DB rows without
// needing the original RawStockData.

function getHorizonScore(
  r: { compositeScore?: number | null; factorMomentum?: number | null; factorTrend?: number | null;
       factorEarnings?: number | null; factorValuation?: number | null; factorQuality?: number | null;
       factorSentiment?: number | null; factorVolatility?: number | null },
  h: string
): { score: number; debug: Record<string, number | null> } {
  const w = HORIZON_WEIGHTS[h] ?? HORIZON_WEIGHTS["60"];

  const factorMap: Record<string, number | null> = {
    momentum:  r.factorMomentum  ?? null,
    trend:     r.factorTrend     ?? null,
    earnings:  r.factorEarnings  ?? null,
    valuation: r.factorValuation ?? null,
    quality:   r.factorQuality   ?? null,
    sentiment: r.factorSentiment ?? null,
  };

  let weightedSum = 0, weightUsed = 0;
  for (const [key, weight] of Object.entries({
    momentum: w.momentum, trend: w.trend, earnings: w.earnings,
    valuation: w.valuation, quality: w.quality, sentiment: w.sentiment,
  })) {
    const v = factorMap[key];
    if (v !== null && v !== undefined) {
      weightedSum += v * weight;
      weightUsed  += weight;
    }
  }

  // If we have no raw factors, fall back to compositeScore (never worse than 50)
  let score = weightUsed > 0
    ? Math.max(0, Math.min(100, weightedSum / weightUsed))
    : (r.compositeScore ?? 50);

  // Apply volatility penalty at horizon-specific multiplier
  const vol = r.factorVolatility ?? null;
  if (vol !== null && vol > 50) {
    score = Math.max(0, score - (vol - 50) * w.volatilityPenaltyMultiplier);
  }

  return {
    score: Math.round(score * 100) / 100,
    debug: { ...factorMap, volatility: vol, weightUsed: Math.round(weightUsed * 100) / 100 },
  };
}

// ─── Confidence per horizon (from stored confidence fields + horizon discount) ─

function getLiveConfidence(
  r: { confidence20d?: number | null; confidence60d?: number | null;
       confidence120d?: number | null; confidence250d?: number | null },
  h: string
): number {
  // Use stored horizon confidence if available; otherwise fall back to 60d
  const stored: Record<string, number | null | undefined> = {
    "20": r.confidence20d, "60": r.confidence60d, "120": r.confidence120d, "250": r.confidence250d,
  };
  const val = stored[h];
  if (val != null && val > 0) return Math.round(val * 10) / 10;
  // Fallback: use 60d with horizon discount
  const base = r.confidence60d ?? 50;
  const discount: Record<string, number> = { "20": 0, "60": 0, "120": 5, "250": 12 };
  return Math.max(0, Math.min(100, Math.round((base - (discount[h] ?? 0)) * 10) / 10));
}

// ─── Explanation regeneration for a given horizon + signal ────────────────────

function buildLiveExplanation(
  r: { factorMomentum?: number | null; factorTrend?: number | null;
       factorEarnings?: number | null; factorValuation?: number | null;
       factorQuality?: number | null },
  horizonScore: number,
  h: string,
  signal: string,
  rank: number,
  percentile: number
): string {
  const w = HORIZON_WEIGHTS[h] ?? HORIZON_WEIGHTS["60"];
  const headlines: Record<string, Record<string, string>> = {
    "20": {
      buy:   "Short-term momentum and catalysts appear favorable.",
      watch: "Short-term signals are mixed; no strong momentum edge.",
      avoid: "Short-term momentum and trend signals are weak or deteriorating.",
    },
    "60": {
      buy:   "Medium-term earnings direction and momentum suggest outperformance potential.",
      watch: "Medium-term signals are mixed; balanced risk/reward.",
      avoid: "Medium-term signals indicate elevated underperformance risk.",
    },
    "120": {
      buy:   "Business quality, earnings persistence, and valuation support a constructive 6-month view.",
      watch: "Quality and valuation mixed; intermediate-term outlook neutral.",
      avoid: "Weak quality or stretched valuation create 6-month headwinds.",
    },
    "250": {
      buy:   "Strong quality and attractive valuation support a favorable 12-month thesis.",
      watch: "Long-term quality and valuation are neutral.",
      avoid: "Weak fundamentals or stretched valuation create 12-month headwinds.",
    },
  };

  const parts = [headlines[h]?.[signal] ?? "Signals are mixed."];
  parts.push(`[${w.label}] Rank #${rank} (top ${Math.round(100 - percentile)}%, score ${horizonScore.toFixed(1)}/100).`);

  const positives: string[] = [], concerns: string[] = [];
  const checks: Array<[number | null | undefined, number, string, string]> = [
    [r.factorMomentum,  w.momentum,  "strong momentum",           "weak momentum"],
    [r.factorTrend,     w.trend,     "confirmed uptrend",         "below key MAs"],
    [r.factorEarnings,  w.earnings,  "favorable earnings",        "deteriorating earnings"],
    [r.factorValuation, w.valuation, "attractive valuation",      "stretched valuation"],
    [r.factorQuality,   w.quality,   "high-quality fundamentals", "weak fundamentals"],
  ];
  for (const [val, weight, pos, neg] of checks) {
    if (val == null) continue;
    const th = weight >= 0.15 ? { p: 65, n: 38 } : { p: 70, n: 32 };
    if (val >= th.p) positives.push(pos);
    else if (val <= th.n) concerns.push(neg);
  }
  if (positives.length) parts.push(`Positives: ${positives.join(", ")}.`);
  if (concerns.length)  parts.push(`Concerns: ${concerns.join(", ")}.`);
  parts.push("⚠ Probabilistic model output. Not financial advice.");
  return parts.join(" ");
}

// ─── Route Registration ───────────────────────────────────────────────────────

export async function registerRoutes(httpServer: Server, app: Express) {

  logInfo("startup", "Registering routes");

  // ── Security headers (applied to all responses) ──────────────────────────
  app.disable("x-powered-by");
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // ── Public auth routes (no token required) ─────────────────────────────

  // GET /api/auth/status — validate access-link token
  app.get("/api/auth/status", readLimiter, async (req: Request, res: Response) => {
    const raw =
      extractBearer(req.headers.authorization) ??
      (req.query.token as string | undefined) ??
      null;
    if (raw) {
      const link = await storage.getAccessLink(raw);
      if (link && link.isActive) {
        storage.touchAccessLink(link.id);
        return res.json({ authenticated: true, type: link.type });
      }
    }
    return res.json({ authenticated: false });
  });

  // POST /api/auth/logout — client clears memory token; no server state needed
  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.json({ success: true });
  });

  // GET /api/me — returns permission type for the authenticated client
  app.get("/api/me", readLimiter, requireAuth, (req: Request, res: Response) => {
    const link = (req as any).accessLink as { id: string; type: string };
    res.json({ type: link.type });
  });

  // GET /api/auth/bootstrap — create first access link when none exist
  app.get("/api/auth/bootstrap", async (_req: Request, res: Response) => {
    const count = storage.accessLinkCount();
    if (count > 0) {
      return res.status(403).json({ error: "Bootstrap already used. Use /admin to manage access links." });
    }
    const id = crypto.randomBytes(16).toString("hex");
    const link = await storage.createAccessLink(id, "Bootstrap Admin", "admin");
    const baseUrl = `https://web-production-04002.up.railway.app`;
    return res.json({
      message: "First admin access link created.",
      accessLink: `${baseUrl}?token=${link.id}`,
      token: link.id,
    });
  });

  // ── /api/admin/links — access link CRUD (admin password required) ──────────

  // GET /api/admin/links — list all links (token value not returned)
  app.get("/api/admin/links", requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      const links = await storage.getAllAccessLinks();
      const safe = links.map((l) => ({
        _id: l.id,       // used by revoke (admin-only endpoint, OK to expose here)
        label: l.label,
        type: l.type,
        createdAt: l.createdAt,
        lastUsedAt: l.lastUsedAt,
        isActive: l.isActive,
      }));
      res.json(safe);
    } catch (err) {
      logError("admin/links", "Failed to list links", err);
      res.status(500).json({ error: "Something went wrong." });
    }
  });

  // POST /api/admin/links — create a new access link
  app.post("/api/admin/links", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { label, type } = req.body as { label?: string; type?: string };
      if (!type || (type !== "admin" && type !== "viewer")) {
        return res.status(400).json({ error: "type must be 'admin' or 'viewer'" });
      }
      const safeLabel = (label || "").trim() || "Unnamed";
      const id = crypto.randomBytes(16).toString("hex");
      const link = await storage.createAccessLink(id, safeLabel, type as "admin" | "viewer");
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      return res.json({
        token: link.id,
        url: `${baseUrl}?token=${link.id}`,
        label: link.label,
        type: link.type,
        createdAt: link.createdAt,
      });
    } catch (err) {
      logError("admin/links", "Failed to create link", err);
      res.status(500).json({ error: "Something went wrong." });
    }
  });

  // DELETE /api/admin/links/:linkId — revoke an access link
  app.delete("/api/admin/links/:linkId", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      await storage.revokeAccessLink(req.params.linkId);
      res.json({ success: true });
    } catch (err) {
      logError("admin/links", "Failed to revoke link", err);
      res.status(500).json({ error: "Something went wrong." });
    }
  });

  // ── Admin panel SSR ──────────────────────────────────────────────────

  app.get("/admin/login", (_req: Request, res: Response) => {
    const adminPassword = process.env.ADMIN_PASSWORD;
    res.send(adminLoginHtml());
  });

  app.post("/admin/login", (req: Request, res: Response) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) return res.send(adminErrorHtml("ADMIN_PASSWORD env var is not set. Add it in Railway Variables then redeploy."));
    const input = (password || "").trim();
    const stored = adminPassword.trim();
    if (input !== stored) return res.send(adminLoginHtml("Wrong password. Check ADMIN_PASSWORD in Railway Variables."));
    // Store raw ADMIN_PASSWORD in sessionStorage, use as adminToken param
    return res.send(adminLoginSuccessHtml(adminPassword));
  });

  // GET /admin — serve admin panel
  app.get("/admin", requireAdminAuth, async (req: Request, res: Response) => {
    const links = await storage.getAllAccessLinks();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const adminToken = (req as any).adminToken as string;
    res.send(adminPanelHtml(links, baseUrl, adminToken));
  });

  app.get("/admin/logout", (_req: Request, res: Response) => {
    // Clear sessionStorage via HTML page, then redirect to login
    return res.send(adminLogoutHtml());
  });

  // ── Health Check ───────────────────────────────────────────────────────────
  // Lightweight ping endpoint — no DB access, always fast.
  // ── Auth middleware for all /api/* routes (except auth itself) ────────────
  // Apply rate limiters + access-link auth to all /api/* routes
  app.use("/api", (req: Request, res: Response, next: Function) => {
    // Exempt public endpoints from auth
    const exemptPaths = ["/auth/status", "/auth/logout", "/me", "/health", "/auth/bootstrap", "/admin/emergency-cleanup"];
    // /api/admin/* routes have their own requireAdminAuth middleware — exempt from token auth
    const isAdminRoute = req.path.startsWith("/admin/");
    const isPublic = exemptPaths.some(p => req.path === p || req.path.startsWith("/auth/"));
    if (isPublic || isAdminRoute) return next();
    requireAuth(req, res, next as NextFunction);
  });

  // Apply write-rate-limiter to all mutating endpoints
  app.use("/api", (req: Request, _res: Response, next: Function) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return readLimiter(req as any, _res as any, next as any);
    }
    return writeLimiter(req as any, _res as any, next as any);
  });

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  });

  // ── Status & Scheduler ─────────────────────────────────────────────────────

  app.get("/api/status", async (_req: Request, res: Response) => {
    try {
      const lastRefresh = await storage.getLastRefresh();
      const scheduler = getSchedulerState();
      const intervalSetting = await storage.getSetting("refresh_interval");
      res.json({
        scheduler,
        lastRefresh,
        currentInterval: intervalSetting ? parseInt(intervalSetting) : 15,
        timestamp: new Date().toISOString(),
        disclaimer: "This is a research tool for informational purposes only. Not financial advice.",
      });
    } catch (err) {
      logError("status", "Failed to fetch status", err);
      res.status(500).json({ error: "Failed to fetch status", detail: String(err) });
    }
  });

  app.post("/api/scheduler/start", requireWriteAuth, async (req: Request, res: Response) => {
    const { interval } = req.body;
    const validIntervals = [5, 15, 30, 60];
    const mins = validIntervals.includes(interval) ? interval : 15;
    await storage.setSetting("refresh_interval", String(mins));
    startScheduler(mins);
    res.json({ success: true, intervalMinutes: mins });
  });

  app.post("/api/scheduler/stop", requireWriteAuth, (_req: Request, res: Response) => {
    stopScheduler();
    res.json({ success: true });
  });

  app.post("/api/refresh", requireWriteAuth, async (_req: Request, res: Response) => {
    logInfo("refresh", "Manual refresh triggered");
    try {
      const result = await runRefresh("manual");
      logInfo("refresh", "Manual refresh completed", result as any);
      res.json({ success: true, ...result });
    } catch (err) {
      logError("refresh", "Manual refresh failed", err);
      res.status(500).json({ error: "Refresh failed", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/refresh/history", async (_req: Request, res: Response) => {
    const history = await storage.getRefreshHistory(20);
    res.json(history);
  });

  // ── Universe ───────────────────────────────────────────────────────────────

  app.get("/api/universe", async (req: Request, res: Response) => {
    const { region, exchange, sector, country, assetType, search } = req.query;
    const stocks = await storage.getAllUniverseStocks({
      region: region as string, exchange: exchange as string,
      sector: sector as string, country: country as string,
      assetType: assetType as string, search: search as string,
    });
    res.json(stocks);
  });

  app.post("/api/universe", requireWriteAuth, async (req: Request, res: Response) => {
    try {
      const data = insertUniverseSchema.parse(req.body);
      const stock = await storage.addToUniverse(data);
      res.json(stock);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/universe/:ticker", requireWriteAuth, async (req: Request, res: Response) => {
    await storage.removeFromUniverse(req.params.ticker);
    res.json({ success: true });
  });

  app.post("/api/universe/seed", requireWriteAuth, async (req: Request, res: Response) => {
    try {
      const { seedFromTickerData } = await import("./lib/universeSeed");
      const result = await seedFromTickerData();
      logInfo("universe/seed", `Seeded universe`, result);
      res.json({ success: true, ...result });
    } catch (err) {
      logError("universe/seed", "Failed to seed universe", err);
      res.status(500).json({ error: "Failed to seed universe", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/universe/expand — additive global universe expansion (~2500 tickers)
  // INSERT OR IGNORE semantics: never touches existing rows
  app.post("/api/universe/expand", requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      logInfo("universe/expand", "Starting global universe expansion...");
      const result = await expandUniverse();
      logInfo("universe/expand", `Expansion complete`, result);
      res.json({ success: true, ...result });
    } catch (err) {
      logError("universe/expand", "Failed to expand universe", err);
      res.status(500).json({ error: "Failed to expand universe", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Recommendations ────────────────────────────────────────────────────────

  app.get("/api/recommendations", async (req: Request, res: Response) => {
    const requestStart = Date.now();
    const { region, exchange, sector, country, assetType, minScore, maxScore, topK } = req.query;
    const strictness = (req.query.strictness as string) || (await storage.getSetting("strictness")) || "balanced";
    // Normalise horizon: only accept valid keys; map legacy aliases like '1y' -> '250'
    const _horizonRaw = (req.query.horizon as string) || "60";
    const horizonAliasMap: Record<string, string> = { "1y": "250", "6m": "120", "3m": "60", "1m": "20" };
    const horizon = HORIZON_WEIGHTS[_horizonRaw] ? _horizonRaw : (horizonAliasMap[_horizonRaw] ?? "60");
    const liquidityFilter = (req.query.liquidityFilter as string) || "moderate";

    logInfo("recommendations", "Request received", {
      horizon, strictness, region, exchange, sector, country, assetType,
      topK, minScore, maxScore,
    });

    try {
      if (req.query.strictness) await storage.setSetting("strictness", strictness);

      const config = STRICTNESS_PRESETS[strictness] ?? STRICTNESS_PRESETS.balanced;

      // Load all stored records for active universe
      let recs = await storage.getLatestRecommendations({
        region: region as string, exchange: exchange as string,
        sector: sector as string, country: country as string,
        assetType: assetType as string,
      });

      logInfo("recommendations", `Loaded ${recs.length} records from DB`);

      // Check if we have any data at all
      if (recs.length === 0) {
        logInfo("recommendations", "No data in DB — returning empty with instructions");
        return res.json({
          data: [], count: 0, totalInUniverse: 0, strictness, horizon,
          thresholds: { buyTopPct: config.buyTopPct, watchPct: config.watchPct,
            buyCount: 0, watchCount: 0, avoidCount: 0 },
          computedAt: new Date().toISOString(),
          cacheNote: "No data available. Click Refresh to fetch stock data from Yahoo Finance.",
          warning: "NO_DATA",
          timestamp: new Date().toISOString(),
          disclaimer: "Model outputs are probabilistic estimates, not financial advice.",
        });
      }

      // Dimension filters
      if (region)    recs = recs.filter(r => r.region    === region);
      if (exchange)  recs = recs.filter(r => r.exchange  === exchange);
      if (sector)    recs = recs.filter(r => r.sector    === sector);
      if (country)   recs = recs.filter(r => r.country   === country);
      if (assetType) recs = recs.filter(r => r.assetType === assetType);
      if (minScore)  recs = recs.filter(r => (r.compositeScore ?? 0)   >= parseFloat(minScore as string));
      if (maxScore)  recs = recs.filter(r => (r.compositeScore ?? 100) <= parseFloat(maxScore as string));

      // Liquidity filter: market cap + volume thresholds, OTC/PINK exclusion
      if (liquidityFilter === "moderate") {
        recs = recs.filter(r => {
          // Exclude OTC/PINK by exchange name
          const exc = (r.exchange ?? "").toUpperCase();
          if (exc === "OTC" || exc === "PINK" || exc === "PINKSHEET" || exc === "OTCBB") return false;
          // Market cap >= 2B (stored as raw number, e.g. 2_000_000_000)
          if (r.marketCap !== null && r.marketCap !== undefined && r.marketCap < 2_000_000_000) return false;
          // Avg 20d volume >= 500K
          if (r.avgVolume20d !== null && r.avgVolume20d !== undefined && r.avgVolume20d < 500_000) return false;
          return true;
        });
      } else if (liquidityFilter === "strict") {
        recs = recs.filter(r => {
          const exc = (r.exchange ?? "").toUpperCase();
          if (exc === "OTC" || exc === "PINK" || exc === "PINKSHEET" || exc === "OTCBB") return false;
          if (r.marketCap !== null && r.marketCap !== undefined && r.marketCap < 10_000_000_000) return false;
          if (r.avgVolume20d !== null && r.avgVolume20d !== undefined && r.avgVolume20d < 1_000_000) return false;
          return true;
        });
      }
      // liquidityFilter === "off" => no filtering

      const n = recs.length;

      // ── Live per-horizon scoring ──────────────────────────────────────────
      // Each horizon uses distinct factor weights from HORIZON_WEIGHTS.
      // This is recomputed fresh on every request from the stored raw factor scores.

      const withHorizonScore = recs.map(r => {
        const { score, debug } = getHorizonScore(r, horizon);
        const confidence = getLiveConfidence(r, horizon);
        return { ...r, _horizonScore: score, _horizonDebug: debug, _confidence: confidence };
      });

      withHorizonScore.sort((a, b) => b._horizonScore - a._horizonScore);

      const buyCount   = Math.max(1, Math.ceil((config.buyTopPct / 100) * n));
      const watchCount = Math.max(1, Math.ceil((config.watchPct / 100) * n));

      const labeled = withHorizonScore.map((r, rank0) => {
        const rank       = rank0 + 1;
        const percentile = Math.round(((n - rank0) / n) * 100 * 10) / 10;
        const signal     = rank <= buyCount ? "buy" : rank <= buyCount + watchCount ? "watch" : "avoid";

        // Regenerate horizon-specific explanation
        const liveExplanation = buildLiveExplanation(r, r._horizonScore, horizon, signal, rank, percentile);

        return {
          ...r,
          // Remove internal scratch fields
          _horizonScore: undefined, _horizonDebug: undefined, _confidence: undefined,
          // Live fields
          liveRank:         rank,
          livePercentile:   percentile,
          liveHorizonScore: Math.round(r._horizonScore * 10) / 10,
          liveSignal:       signal,
          liveHorizon:      horizon,
          liveStrictness:   strictness,
          liveConfidence:   Math.round(r._confidence * 10) / 10,
          liveExplanation,
          // Per-horizon factor weights (so the UI can show them)
          horizonWeights: {
            momentum:  HORIZON_WEIGHTS[horizon].momentum,
            trend:     HORIZON_WEIGHTS[horizon].trend,
            earnings:  HORIZON_WEIGHTS[horizon].earnings,
            valuation: HORIZON_WEIGHTS[horizon].valuation,
            quality:   HORIZON_WEIGHTS[horizon].quality,
            sentiment: HORIZON_WEIGHTS[horizon].sentiment,
            volatilityPenaltyMultiplier: HORIZON_WEIGHTS[horizon].volatilityPenaltyMultiplier,
            label:     HORIZON_WEIGHTS[horizon].label,
            targetDescription: HORIZON_WEIGHTS[horizon].targetDescription,
          },
          // Keep legacy signal fields for backward compat
          signal20d:  horizon === "20"  ? signal : r.signal20d,
          signal60d:  horizon === "60"  ? signal : r.signal60d,
          signal120d: horizon === "120" ? signal : r.signal120d,
          signal250d: horizon === "250" ? signal : r.signal250d,
        };
      });

      // Signal filter
      let filtered = labeled;
      const signalFilter = req.query.signal as string;
      if (signalFilter && signalFilter !== "all") {
        filtered = filtered.filter(r => r.liveSignal === signalFilter);
      }

      // Top-K
      const topKNum = topK ? parseInt(topK as string) : 0;
      if (topKNum > 0) filtered = filtered.slice(0, topKNum);

      const duration = Date.now() - requestStart;
      logInfo("recommendations", `Returning ${filtered.length}/${n} records`, {
        horizon, strictness, buyCount, watchCount, durationMs: duration,
        cacheNote: "live-recomputed",
      });

      // Sample score spread for diagnostics (proves horizons differ)
      const scoreSpread = {
        min: Math.min(...withHorizonScore.map(r => r._horizonScore)),
        max: Math.max(...withHorizonScore.map(r => r._horizonScore)),
        top3: withHorizonScore.slice(0, 3).map(r => ({ ticker: r.ticker, score: r._horizonScore })),
      };

      res.json({
        data: filtered,
        count: filtered.length,
        totalInUniverse: n,
        strictness,
        horizon,
        thresholds: {
          buyTopPct: config.buyTopPct,
          watchPct:  config.watchPct,
          buyCount,
          watchCount,
          avoidCount: n - buyCount - watchCount,
        },
        horizonProfile: {
          label:             HORIZON_WEIGHTS[horizon].label,
          targetDescription: HORIZON_WEIGHTS[horizon].targetDescription,
          weights: {
            momentum:  HORIZON_WEIGHTS[horizon].momentum,
            trend:     HORIZON_WEIGHTS[horizon].trend,
            earnings:  HORIZON_WEIGHTS[horizon].earnings,
            valuation: HORIZON_WEIGHTS[horizon].valuation,
            quality:   HORIZON_WEIGHTS[horizon].quality,
            sentiment: HORIZON_WEIGHTS[horizon].sentiment,
          },
        },
        scoreSpread,
        computedAt:  new Date().toISOString(),
        durationMs:  duration,
        cacheNote:   "Labels recomputed live on each request using horizon-specific factor weights.",
        recomputeEvidence: `Horizon ${horizon}d weights applied: ${JSON.stringify({
          mom: HORIZON_WEIGHTS[horizon].momentum,
          trnd: HORIZON_WEIGHTS[horizon].trend,
          earn: HORIZON_WEIGHTS[horizon].earnings,
          val:  HORIZON_WEIGHTS[horizon].valuation,
          qual: HORIZON_WEIGHTS[horizon].quality,
        })}`,
        timestamp:   new Date().toISOString(),
        disclaimer:  "Model outputs are probabilistic estimates, not financial advice.",
      });

    } catch (err) {
      const duration = Date.now() - requestStart;
      logError("recommendations", `Request failed after ${duration}ms`, err);
      res.status(500).json({
        error: "Failed to compute recommendations",
        detail: err instanceof Error ? err.message : String(err),
        horizon,
        strictness,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Stock Detail ───────────────────────────────────────────────────────────

  app.get("/api/stock/:ticker", async (req: Request, res: Response) => {
    const { ticker } = req.params;
    const horizon    = (req.query.horizon as string) || "60";
    logInfo("stock-detail", `Fetching detail for ${ticker} horizon=${horizon}`);

    try {
      const [snapshot, recommendation, history] = await Promise.all([
        storage.getLatestSnapshot(ticker),
        storage.getLatestRecommendationForTicker(ticker),
        storage.getRecommendationHistory(ticker, 10),
      ]);

      if (!snapshot && !recommendation) {
        return res.status(404).json({ error: `No data found for ${ticker}. Run a refresh first.` });
      }

      // Compute live horizon scores for this stock across all 4 horizons
      const horizonScores: Record<string, { score: number; confidence: number; label: string }> = {};
      for (const h of ["20", "60", "120", "250"]) {
        if (recommendation) {
          const { score } = getHorizonScore(recommendation as any, h);
          const confidence = getLiveConfidence(recommendation as any, h);
          horizonScores[`d${h}`] = {
            score: Math.round(score * 10) / 10,
            confidence: Math.round(confidence * 10) / 10,
            label: HORIZON_WEIGHTS[h].label,
          };
        }
      }

      res.json({
        ticker,
        snapshot,
        recommendation,
        horizonScores,
        history,
        disclaimer: "All data from Yahoo Finance (primary). Model scores are probabilistic, not price predictions.",
      });
    } catch (err) {
      logError("stock-detail", `Failed for ${ticker}`, err);
      res.status(500).json({ error: "Failed to fetch stock detail", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Live fetch for a specific ticker ──────────────────────────────────────

  app.post("/api/stock/:ticker/refresh", requireWriteAuth, async (req: Request, res: Response) => {
    const { ticker } = req.params;
    const alphaKey   = process.env.ALPHAVANTAGE_API_KEY;
    const strictness = (await storage.getSetting("strictness")) || "balanced";
    logInfo("ticker-refresh", `Refreshing ${ticker}`);

    try {
      // Fetch live data, then apply stored fallbacks for missing fundamentals (Fix #11B)
      const rawFresh = await fetchStockData(ticker, alphaKey);
      const storedSnap = rawFresh.price ? await storage.getLatestSnapshot(ticker) : null;
      const raw = storedSnap ? applyStoredFallbacks(rawFresh, storedSnap as any) : rawFresh;

      // Pass sector metadata so rankMultiple can apply sector rules (Fix #12)
      const universeEntry = await storage.getUniverseItem(ticker);
      const [ranking] = rankMultiple(
        [raw],
        strictness,
        [{ sector: universeEntry?.sector, assetType: universeEntry?.assetType }]
      );
      const snapshotId = await storage.saveSnapshot(raw);
      await storage.saveRecommendation(ranking, snapshotId);
      logInfo("ticker-refresh", `${ticker} refreshed OK`);
      res.json({
        ticker,
        raw: { source: raw.source, freshness: raw.freshness, error: raw.error, price: raw.price, fetchedAt: raw.fetchedAt },
        ranking,
        disclaimer: "Model output. Not financial advice.",
      });
    } catch (err) {
      logError("ticker-refresh", `Failed for ${ticker}`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Watchlists ─────────────────────────────────────────────────────────────

  app.get("/api/watchlists", async (_req: Request, res: Response) => {
    res.json(await storage.getWatchlists());
  });

  app.post("/api/watchlists", requireWriteAuth, async (req: Request, res: Response) => {
    try {
      const data = insertWatchlistSchema.parse(req.body);
      res.json(await storage.createWatchlist(data));
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/watchlists/:id", requireWriteAuth, async (req: Request, res: Response) => {
    const list = await storage.updateWatchlist(parseInt(req.params.id), req.body);
    if (!list) return res.status(404).json({ error: "Watchlist not found" });
    res.json(list);
  });

  app.delete("/api/watchlists/:id", requireWriteAuth, async (req: Request, res: Response) => {
    await storage.deleteWatchlist(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Backtest ───────────────────────────────────────────────────────────────

  app.get("/api/backtest/stats", async (_req: Request, res: Response) => {
    const stats = await storage.getBacktestStats();
    res.json({ ...stats, disclaimer: "Backtest metrics are historical. Past performance does not predict future results." });
  });

  app.get("/api/backtest/records", async (req: Request, res: Response) => {
    const horizon = req.query.horizon ? parseInt(req.query.horizon as string) : undefined;
    res.json(await storage.getBacktestRecords(horizon));
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  app.get("/api/settings", async (_req: Request, res: Response) => {
    const keys = ["refresh_interval", "alphavantage_key_configured", "strictness", "top_k_mode"];
    const result: Record<string, string | null> = {};
    for (const key of keys) result[key] = await storage.getSetting(key);
    res.json(result);
  });

  app.post("/api/settings", requireWriteAuth, async (req: Request, res: Response) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: "key and value required" });
    await storage.setSetting(key, String(value));
    res.json({ success: true });
  });

  // ── Horizon Profiles (expose all weight profiles to the UI) ───────────────

  app.get("/api/horizon-profiles", (_req: Request, res: Response) => {
    res.json(HORIZON_WEIGHTS);
  });

  // ── News & Earnings Calendar ───────────────────────────────────────────────
  // Returns recent news headlines from Yahoo Finance search API.
  // Clearly labelled as sourced data — not model opinions, not invented.

  app.get("/api/news/:ticker", async (req: Request, res: Response) => {
    const { ticker } = req.params;
    const count = Math.min(parseInt((req.query.count as string) || "8"), 20);
    logInfo("news", `Fetching news for ${ticker}`);

    try {
      const url = "https://query2.finance.yahoo.com/v1/finance/search";
      const resp = await axios.get(url, {
        params: { q: ticker, newsCount: count, quotesCount: 0, enableNavLinks: false },
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
        timeout: 8000,
      });

      const raw = (resp.data?.news ?? []) as any[];
      const news = raw.slice(0, count).map((item: any) => ({
        uuid:           item.uuid,
        title:          item.title ?? null,
        publisher:      item.publisher ?? null,
        link:           item.link ?? null,
        publishedAt:    item.providerPublishTime
          ? new Date(item.providerPublishTime * 1000).toISOString()
          : null,
        relatedTickers: item.relatedTickers ?? [],
        thumbnailUrl:   item.thumbnail?.resolutions?.[1]?.url ?? item.thumbnail?.resolutions?.[0]?.url ?? null,
        type:           item.type ?? "STORY",
      }));

      // Pull stored earnings date from DB snapshot (already fetched by dataFetcher)
      const snapshot = await storage.getLatestSnapshot(ticker);
      const earningsDate = snapshot?.earningsDate ?? null;

      logInfo("news", `${ticker}: ${news.length} articles, earningsDate=${earningsDate}`);

      res.json({
        ticker,
        news,
        earningsDate,
        fetchedAt:  new Date().toISOString(),
        source:     "Yahoo Finance (search API)",
        disclaimer: "Headlines sourced from Yahoo Finance. Displayed as sourced data only, not model opinions. Not used in scoring.",
      });
    } catch (err) {
      logError("news", `Failed to fetch news for ${ticker}`, err);
      res.status(500).json({
        ticker,
        news:        [],
        earningsDate: null,
        error:       "Failed to fetch news from Yahoo Finance",
        detail:      err instanceof Error ? err.message : String(err),
        fetchedAt:   new Date().toISOString(),
        source:      "Yahoo Finance (search API)",
      });
    }
  });

  // ── Auto-start scheduler ───────────────────────────────────────────────────
  // ── Refresh Progress endpoint ──────────────────────────────────────────────
  app.get("/api/refresh/progress", (_req: Request, res: Response) => {
    res.json(getRefreshProgress());
  });

  // ── Opportunity Map ──────────────────────────────────────────────────────────

  const VALID_OPP_HORIZONS = ["1y", "3y", "5y", "10y", "20y"];

  // Expose horizon weight table so UI can render methodology tooltip
  app.get("/api/opportunity/horizons", async (_req: Request, res: Response) => {
    try {
      const { OPPORTUNITY_HORIZON_PROFILES } = await import("./lib/opportunityEngine");
      res.json({ horizons: VALID_OPP_HORIZONS, profiles: OPPORTUNITY_HORIZON_PROFILES });
    } catch (err) {
      logError("opportunity/horizons", "Failed", err);
      res.status(500).json({ error: "Failed to load horizon profiles" });
    }
  });

  app.get("/api/opportunity", async (req: Request, res: Response) => {
    try {
      const { region, theme, minUpside, maxRisk, horizon, limit } = req.query;
      const scores = await storage.getOpportunityScores({
        region: region as string | undefined,
        themeTag: theme as string | undefined,
        minUpside: minUpside ? parseFloat(minUpside as string) : undefined,
        maxRisk: maxRisk ? parseFloat(maxRisk as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      const h = VALID_OPP_HORIZONS.includes(horizon as string) ? (horizon as string) : "3y";

      const enriched = scores.map((s) => {
        let tags: string[] = [];
        let horizonScoresRaw: Record<string, { upsideScore: number; riskScore: number; compositeScore: number }> = {};
        try { tags = JSON.parse(s.themeTags); } catch {}
        try { horizonScoresRaw = JSON.parse(s.horizonScores as string); } catch {}

        const hData = horizonScoresRaw[h];
        const horizonScore      = hData?.compositeScore ?? s.upsideScore ?? 0;
        const horizonUpsideScore = hData?.upsideScore   ?? s.upsideScore ?? 0;
        const horizonRiskScore   = hData?.riskScore     ?? s.riskScore   ?? 0;

        return {
          ...s,
          themeTags: tags,
          horizonScores: horizonScoresRaw,
          // Horizon-specific overrides (what the UI should display)
          horizonScore,
          horizonUpsideScore,
          horizonRiskScore,
          // Keep base upsideScore/riskScore as the default (3y) fallback
        };
      });

      const themeCoverage: Record<string, number> = {};
      for (const s of enriched) {
        for (const tag of (s.themeTags as string[])) {
          themeCoverage[tag] = (themeCoverage[tag] ?? 0) + 1;
        }
      }

      res.json({
        count: enriched.length,
        horizon: h,
        validHorizons: VALID_OPP_HORIZONS,
        scores: enriched,
        themeCoverage,
        disclaimer: "Opportunity Scores are independent of Buy/Watch/Avoid signals. Computed from Yahoo Finance data. Probabilistic model outputs only — not financial advice.",
      });
    } catch (err) {
      logError("opportunity", "Failed to get opportunity scores", err);
      res.status(500).json({ error: "Failed to get opportunity scores", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Fix names: backfill company names for tickers with numeric/bare names ──
  app.post("/api/universe/fix-names", requireWriteAuth, async (_req: Request, res: Response) => {
    try {
      const activeStocks = await storage.getActiveUniverseStocks();
      const needsName = (s: { name: string; ticker: string }) => {
        const n = (s.name ?? "").trim();
        return !n || n === s.ticker || /^[\d\s.]+$/.test(n);
      };
      const toFix = activeStocks.filter(needsName);

      logInfo("fix-names", `Found ${toFix.length} tickers needing name fix`);
      const alphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;
      let fixed = 0, failed = 0;

      for (let i = 0; i < toFix.length; i++) {
        const stock = toFix[i];
        try {
          const raw = await fetchStockData(stock.ticker, alphaVantageKey);
          // Fallback chain: longName → shortName → displayName → quoteType → ticker
          const newName = raw.longName || raw.shortName || (raw as any).displayName || raw.quoteType || stock.ticker;
          await storage.updateUniverseName(stock.ticker, newName);
          fixed++;
          logInfo("fix-names", `Fixed ${stock.ticker}: "${stock.name}" -> "${newName}"`);
        } catch {
          failed++;
        }
        // Rate limit: 1 per 400ms
        if (i + 1 < toFix.length) {
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      res.json({ success: true, checked: toFix.length, fixed, failed });
    } catch (err) {
      logError("fix-names", "Failed", err);
      res.status(500).json({ error: "Fix names failed", detail: String(err) });
    }
  });

  // ── Failed stocks ──────────────────────────────────────────────────────────
  app.get("/api/diagnostics/failed-stocks", async (_req: Request, res: Response) => {
    try {
      const failed = await storage.getFailedStocks();
      const active = failed.filter((f) => !f.autoRemoved);
      const byCategory: Record<string, number> = {};
      for (const f of active) {
        byCategory[f.errorCategory] = (byCategory[f.errorCategory] ?? 0) + 1;
      }
      res.json({ count: active.length, byCategory, stocks: active, autoRemovedCount: failed.filter((f) => f.autoRemoved).length });
    } catch (err) {
      res.status(500).json({ error: "Failed to get failed stocks", detail: String(err) });
    }
  });

  // POST /api/diagnostics/deactivate-dead-tickers
  // Immediately deactivates all not_found tickers (404/delisted). Safe to call after a
  // universe reseed — cleans up ~150 dead tickers without waiting for 2 refresh cycles.
  app.post("/api/diagnostics/deactivate-dead-tickers", requireWriteAuth, async (_req: Request, res: Response) => {
    try {
      const failedList = await storage.getFailedStocks();
      const dead = failedList.filter((f) => !f.autoRemoved && f.errorCategory === "not_found");
      let deactivated = 0;
      for (const f of dead) {
        await storage.removeFromUniverse(f.ticker);
        await storage.flagAutoRemoved(f.ticker, `not_found x${f.consecutiveFails} (manual flush)`);
        deactivated++;
      }
      logInfo("deactivate-dead", `Deactivated ${deactivated} not_found tickers`);
      res.json({ success: true, deactivated, tickers: dead.map((f) => f.ticker) });
    } catch (err) {
      logError("deactivate-dead", "Failed", err);
      res.status(500).json({ error: "Failed", detail: String(err) });
    }
  });

  // POST /api/diagnostics/retry-failed — retry failed stocks only
  app.post("/api/diagnostics/retry-failed", requireWriteAuth, async (_req: Request, res: Response) => {
    try {
      const failedList = await storage.getFailedStocks();
      const toRetry = failedList.filter((f) => !f.autoRemoved);
      if (toRetry.length === 0) {
        return res.json({ success: true, attempted: 0, succeeded: 0, failed: 0, message: "No failed stocks to retry" });
      }

      const alphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;
      let succeeded = 0, stillFailed = 0;

      logInfo("retry-failed", `Retrying ${toRetry.length} failed stocks`);

      for (let i = 0; i < toRetry.length; i++) {
        const f = toRetry[i];
        try {
          const raw = await fetchStockData(f.ticker, alphaVantageKey);
          if (!raw.error && raw.price) {
            const { rankMultiple } = await import("./lib/rankingEngine");
            const strictness = (await storage.getSetting("strictness")) || "balanced";
            const rankings = rankMultiple([raw], strictness);
            const ranking = rankings[0];
            if (ranking) {
              const snapshotId = await storage.saveSnapshot(raw);
              await storage.saveRecommendation(ranking, snapshotId);
              await storage.resetConsecutiveFails(f.ticker);
            }
            succeeded++;
          } else {
            stillFailed++;
          }
        } catch {
          stillFailed++;
        }
        if (i + 1 < toRetry.length) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      return res.json({ success: true, attempted: toRetry.length, succeeded, failed: stillFailed });
    } catch (err) {
      logError("retry-failed", "Retry failed", err);
      return res.status(500).json({ error: "Retry failed", detail: String(err) });
    }
  });

  // POST /api/diagnostics/clear-failed/:ticker
  app.post("/api/diagnostics/clear-failed/:ticker", requireWriteAuth, async (req: Request, res: Response) => {
    await storage.clearFailedStock(req.params.ticker);
    res.json({ success: true });
  });

  // ─── Fundamentals endpoints ────────────────────────────────────────────────

  // GET /api/fundamentals — all stocks with enriched fundamental fields
  app.get("/api/fundamentals", requireAuth, async (req: Request, res: Response) => {
    try {
      // Pull fundamental data directly from raw sqlite (same pattern used in getLatestRecommendations)
      const fundamentalRows = rawSqlite.prepare(`
        SELECT r.ticker, r.composite_score,
          r.factor_momentum, r.factor_trend, r.factor_earnings, r.factor_valuation,
          r.factor_quality, r.factor_sentiment, r.factor_volatility,
          r.signal_20d, r.signal_60d, r.signal_120d, r.signal_250d,
          r.confidence_20d, r.confidence_60d, r.confidence_120d, r.confidence_250d,
          u.name as stock_name, u.sector, u.industry, u.exchange, u.country, u.region,
          s.price, s.change_pct,
          s.pe, s.eps_growth_yoy, s.revenue_growth_yoy, s.gross_margin,
          s.free_cash_flow, s.analyst_buy, s.analyst_hold, s.analyst_sell,
          s.operating_margin, s.roe, s.debt_equity,
          s.short_percent_of_float, s.earnings_date,
          u.market_cap as univ_market_cap
        FROM recommendations r
        JOIN universe u ON r.ticker = u.ticker
        LEFT JOIN price_snapshots s ON s.id = r.snapshot_id
        WHERE r.id IN (
          SELECT MAX(id) FROM recommendations GROUP BY ticker
        )
        AND u.is_active = 1
        ORDER BY r.composite_score DESC
      `).all() as any[];

      const result = fundamentalRows.map((row: any) => {
        const pe = row.pe ?? null;
        const epsGrowth = row.eps_growth_yoy ?? null;
        const pegRatio = (pe != null && epsGrowth != null && epsGrowth > 0)
          ? pe / (epsGrowth / 100)
          : null;
        const marketCap = row.univ_market_cap ?? null;
        const fcfYield = (row.free_cash_flow != null && marketCap != null && marketCap > 0)
          ? row.free_cash_flow / marketCap
          : null;
        return {
          ticker: row.ticker,
          stockName: row.stock_name,
          sector: row.sector,
          industry: row.industry ?? null,
          exchange: row.exchange,
          country: row.country,
          region: row.region,
          price: row.price,
          changePct: row.change_pct,
          compositeScore: row.composite_score,
          factorMomentum: row.factor_momentum,
          factorTrend: row.factor_trend,
          factorEarnings: row.factor_earnings,
          factorValuation: row.factor_valuation,
          factorQuality: row.factor_quality,
          factorSentiment: row.factor_sentiment,
          factorVolatility: row.factor_volatility,
          signal20d: row.signal_20d,
          signal60d: row.signal_60d,
          signal120d: row.signal_120d,
          signal250d: row.signal_250d,
          confidence20d: row.confidence_20d,
          confidence60d: row.confidence_60d,
          confidence120d: row.confidence_120d,
          confidence250d: row.confidence_250d,
          // Fundamentals
          revenueGrowthYoy: row.revenue_growth_yoy ?? null,
          grossMargin: row.gross_margin ?? null,
          pegRatio,
          fcfYield,
          freeCashFlow: row.free_cash_flow ?? null,
          marketCap,
          pe,
          epsGrowthYoy: epsGrowth,
          operatingMargin: row.operating_margin ?? null,
          roe: row.roe ?? null,
          debtEquity: row.debt_equity ?? null,
          analystBuy: row.analyst_buy ?? null,
          analystHold: row.analyst_hold ?? null,
          analystSell: row.analyst_sell ?? null,
          shortPercentOfFloat: row.short_percent_of_float ?? null,
          earningsDate: row.earnings_date ?? null,
        };
      });

      res.json(result);
    } catch (err) {
      logError("fundamentals", "Failed to fetch fundamentals", err);
      res.status(500).json({ error: "Failed to fetch fundamentals", detail: String(err) });
    }
  });

  // GET /api/fundamentals/sector-peers/:sector — aggregated sector metrics
  app.get("/api/fundamentals/sector-peers/:sector", requireAuth, async (req: Request, res: Response) => {
    try {
      const sector = decodeURIComponent(req.params.sector);
      const peerRows = rawSqlite.prepare(`
        SELECT
          COUNT(*) as stock_count,
          AVG(s.revenue_growth_yoy) as avg_revenue_growth,
          AVG(s.gross_margin) as avg_gross_margin,
          AVG(s.operating_margin) as avg_operating_margin,
          AVG(s.roe) as avg_roe,
          AVG(s.debt_equity) as avg_debt_equity,
          AVG(
            CASE WHEN (s.analyst_buy + s.analyst_hold + s.analyst_sell) > 0
            THEN CAST(s.analyst_buy AS REAL) / (s.analyst_buy + s.analyst_hold + s.analyst_sell)
            ELSE NULL END
          ) as avg_buy_ratio,
          AVG(
            CASE WHEN (s.analyst_buy + s.analyst_hold + s.analyst_sell) > 0
            THEN CAST(s.analyst_hold AS REAL) / (s.analyst_buy + s.analyst_hold + s.analyst_sell)
            ELSE NULL END
          ) as avg_hold_ratio,
          AVG(
            CASE WHEN (s.analyst_buy + s.analyst_hold + s.analyst_sell) > 0
            THEN CAST(s.analyst_sell AS REAL) / (s.analyst_buy + s.analyst_hold + s.analyst_sell)
            ELSE NULL END
          ) as avg_sell_ratio,
          AVG(s.free_cash_flow) as avg_fcf,
          AVG(r.composite_score) as avg_composite_score,
          -- PEG = pe / (eps_growth_yoy / 100): only when pe>0 and eps_growth_yoy>0
          AVG(
            CASE WHEN s.pe IS NOT NULL AND s.pe > 0
                  AND s.eps_growth_yoy IS NOT NULL AND s.eps_growth_yoy > 0
            THEN s.pe / (s.eps_growth_yoy / 100.0)
            ELSE NULL END
          ) as avg_peg,
          -- FCF Yield = fcf / market_cap: only when both non-null and market_cap > 0
          AVG(
            CASE WHEN s.free_cash_flow IS NOT NULL
                  AND u.market_cap IS NOT NULL AND u.market_cap > 0
            THEN s.free_cash_flow / u.market_cap
            ELSE NULL END
          ) as avg_fcf_yield
        FROM recommendations r
        JOIN universe u ON r.ticker = u.ticker
        LEFT JOIN price_snapshots s ON s.id = r.snapshot_id
        WHERE r.id IN (
          SELECT MAX(id) FROM recommendations GROUP BY ticker
        )
        AND u.is_active = 1
        AND u.sector = ?
      `).get(sector) as any;

      if (!peerRows) {
        return res.json({ stockCount: 0, avgRevenueGrowth: null, avgGrossMargin: null, avgBuyRatio: null, avgHoldRatio: null, avgSellRatio: null, avgFcf: null, avgCompositeScore: null });
      }

      // Derive capital cycle stage from avg FCF direction
      // Negative avg FCF = high capex / late expansion, positive = capital return / mature
      const avgFcf = peerRows.avg_fcf ?? null;
      let capitalCycleStage: string;
      if (avgFcf === null) {
        capitalCycleStage = "Unknown";
      } else if (avgFcf < -5e8) {
        capitalCycleStage = "Late Expansion"; // heavy capex
      } else if (avgFcf < 0) {
        capitalCycleStage = "Mid Expansion";
      } else if (avgFcf < 1e9) {
        capitalCycleStage = "Early Harvest";
      } else {
        capitalCycleStage = "Capital Return"; // mature, returning cash
      }

      // Analyst consensus trend label
      const buyRatio = peerRows.avg_buy_ratio ?? 0;
      const sellRatio = peerRows.avg_sell_ratio ?? 0;
      let analysisTrend: string;
      if (buyRatio >= 0.6) analysisTrend = "Strong Buy Bias";
      else if (buyRatio >= 0.45) analysisTrend = "Mild Buy Bias";
      else if (sellRatio >= 0.4) analysisTrend = "Sell Bias";
      else analysisTrend = "Neutral";

      res.json({
        sector,
        stockCount: peerRows.stock_count ?? 0,
        avgRevenueGrowth: peerRows.avg_revenue_growth ?? null,
        avgGrossMargin: peerRows.avg_gross_margin ?? null,
        avgOperatingMargin: peerRows.avg_operating_margin ?? null,
        avgRoe: peerRows.avg_roe ?? null,
        avgDebtEquity: peerRows.avg_debt_equity ?? null,
        avgBuyRatio: peerRows.avg_buy_ratio ?? null,
        avgHoldRatio: peerRows.avg_hold_ratio ?? null,
        avgSellRatio: peerRows.avg_sell_ratio ?? null,
        avgFcf,
        avgCompositeScore: peerRows.avg_composite_score ?? null,
        avgPeg: peerRows.avg_peg ?? null,
        avgFcfYield: peerRows.avg_fcf_yield ?? null,
        capitalCycleStage,
        analysisTrend,
      });
    } catch (err) {
      logError("fundamentals-sector", "Failed to fetch sector peers", err);
      res.status(500).json({ error: "Failed to fetch sector peers", detail: String(err) });
    }
  });

  // GET /api/fundamentals/debug-crumb — test Yahoo crumb acquisition using fc.yahoo.com flow
  app.get("/api/fundamentals/debug-crumb", requireAuth, async (req: Request, res: Response) => {
    try {
      const axios2 = (await import("axios")).default;
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      // Step 1: get cookie from fc.yahoo.com (minimal headers, no CSP bloat)
      let cookieStr = "";
      let cookieError = null;
      try {
        const fcResp = await axios2.get("https://fc.yahoo.com", {
          headers: { "User-Agent": UA },
          timeout: 8000, maxRedirects: 3, validateStatus: () => true,
        });
        const setCookie = fcResp.headers["set-cookie"] as string[] | string | undefined;
        const cookies: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        cookieStr = cookies.map((c: string) => c.split(";")[0].trim()).filter(Boolean).join("; ");
      } catch (e: any) { cookieError = e.message; }
      // Step 2: get crumb
      let crumb = null;
      let crumbError = null;
      try {
        const crumbResp = await axios2.get("https://query1.finance.yahoo.com/v1/test/getcrumb", {
          headers: { "User-Agent": UA, "Cookie": cookieStr },
          timeout: 8000, validateStatus: () => true,
        });
        crumb = typeof crumbResp.data === "string" ? crumbResp.data.trim() : null;
        if (crumb?.startsWith("{")) { crumbError = "got JSON: " + crumb.slice(0,100); crumb = null; }
      } catch (e: any) { crumbError = e.message; }
      // Step 3: test quoteSummary
      let summaryResult = null;
      let summaryError = null;
      try {
        const summResp = await axios2.get(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=financialData${crumb ? "&crumb=" + encodeURIComponent(crumb) : ""}`,
          { headers: { "User-Agent": UA, "Cookie": cookieStr }, timeout: 10000, validateStatus: () => true }
        );
        if (summResp.status === 200) {
          const fd = summResp.data?.quoteSummary?.result?.[0]?.financialData || {};
          summaryResult = { grossMargins: fd.grossMargins?.raw, revenueGrowth: fd.revenueGrowth?.raw };
        } else {
          summaryError = `HTTP ${summResp.status}: ${JSON.stringify(summResp.data).slice(0,200)}`;
        }
      } catch (e: any) {
        summaryError = (e?.response?.status || "") + " " + (e?.message || "");
      }
      res.json({ cookieStr: cookieStr.slice(0, 100), cookieError, crumb, crumbError, summaryResult, summaryError });
    } catch (e: any) {
      res.json({ error: e.message, status: e?.response?.status });
    }
  });

  // POST /api/fundamentals/backfill — fetch fundamental data for top N stocks by market_cap
  app.post("/api/fundamentals/backfill", requireWriteAuth, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "10")), 50);
      // Get top tickers by market_cap with their latest snapshot id
      const rows = rawSqlite.prepare(`
        SELECT r.ticker, r.snapshot_id, u.market_cap
        FROM recommendations r
        JOIN universe u ON r.ticker = u.ticker
        WHERE r.id IN (SELECT MAX(id) FROM recommendations GROUP BY ticker)
        AND u.is_active = 1
        AND r.snapshot_id IS NOT NULL
        ORDER BY u.market_cap DESC NULLS LAST
        LIMIT ?
      `).all(limit) as any[];

      const updateStmt = rawSqlite.prepare(`
        UPDATE price_snapshots SET
          revenue_growth_yoy = ?,
          gross_margin = ?,
          operating_margin = ?,
          roe = ?,
          debt_equity = ?,
          free_cash_flow = ?,
          eps_growth_yoy = ?,
          pe = ?,
          pb = ?,
          analyst_buy = ?,
          analyst_hold = ?,
          analyst_sell = ?,
          price_target = ?,
          earnings_date = ?,
          short_percent_of_float = ?
        WHERE id = ?
      `);

      const results: { ticker: string; ok: boolean; error?: string }[] = [];
      for (const row of rows) {
        try {
          const raw = await fetchStockData(row.ticker);
          if (raw.error) {
            results.push({ ticker: row.ticker, ok: false, error: raw.error });
            continue;
          }
          updateStmt.run(
            raw.revenueGrowthYoy ?? null,
            raw.grossMargin ?? null,
            raw.operatingMargin ?? null,
            raw.roe ?? null,
            raw.debtEquity ?? null,
            raw.freeCashFlow ?? null,
            raw.epsGrowthYoy ?? null,
            raw.pe ?? null,
            raw.pb ?? null,
            raw.analystBuy ?? null,
            raw.analystHold ?? null,
            raw.analystSell ?? null,
            raw.priceTarget ?? null,
            raw.earningsDate ?? null,
            raw.shortPercentOfFloat ?? null,
            row.snapshot_id,
          );
          // Also update market_cap in universe if fetched
          if (raw.marketCap) {
            rawSqlite.prepare(`UPDATE universe SET market_cap = ? WHERE ticker = ?`).run(raw.marketCap, row.ticker);
          }
          results.push({ ticker: row.ticker, ok: true, snapshotId: row.snapshot_id, revGrowth: raw.revenueGrowthYoy ?? null, grossMargin: raw.grossMargin ?? null, analystBuy: raw.analystBuy ?? null });
        } catch (e: any) {
          results.push({ ticker: row.ticker, ok: false, error: e.message });
        }
        // Small rate-limit pause
        await new Promise((r) => setTimeout(r, 400));
      }

      const succeeded = results.filter((r) => r.ok).length;
      res.json({ attempted: rows.length, succeeded, results });
    } catch (err) {
      res.status(500).json({ error: "Backfill failed", detail: String(err) });
    }
  });


  // POST /api/fx/backfill — one-time backfill of price_eur / price_usd for all snapshots
  app.post("/api/fx/backfill", requireWriteAuth, async (req: Request, res: Response) => {
    try {
      const rates = await getFxRates();
      if (Object.keys(rates).length === 0) {
        return res.status(503).json({ error: "FX rates unavailable" });
      }
      const rows = rawSqlite.prepare(`
        SELECT s.id, s.price, s.native_currency, u.currency as univ_currency
        FROM price_snapshots s
        JOIN universe u ON s.ticker = u.ticker
        WHERE s.price IS NOT NULL
        AND (s.price_eur IS NULL OR s.price_usd IS NULL)
      `).all() as any[];
      let updated = 0;
      const stmt = rawSqlite.prepare(
        "UPDATE price_snapshots SET native_currency=?, price_eur=?, price_usd=? WHERE id=?"
      );
      rawSqlite.transaction(() => {
        for (const row of rows) {
          const currency: string = row.native_currency || row.univ_currency || "USD";
          const { eur, usd } = convertPrice(row.price, currency, rates);
          stmt.run(currency, eur, usd, row.id);
          updated++;
        }
      })();
      res.json({ updated, ratesAvailable: Object.keys(rates).length });
    } catch (err: any) {
      res.status(500).json({ error: "FX backfill failed", detail: String(err) });
    }
  });

  // ─── Earnings Calendar ────────────────────────────────────────────────

  // GET /api/earnings — stocks with earnings in the next 30 days
  app.get("/api/earnings", requireAuth, async (req: Request, res: Response) => {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const todayStr = now.toISOString().slice(0, 10);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const rows = rawSqlite.prepare(`
        SELECT r.ticker, u.name as stock_name, u.sector, r.composite_score,
               r.signal_20d, s.earnings_date, s.price, s.change_pct,
               r.confidence_20d
        FROM recommendations r
        JOIN universe u ON r.ticker = u.ticker
        LEFT JOIN price_snapshots s ON s.id = r.snapshot_id
        WHERE r.id IN (SELECT MAX(id) FROM recommendations GROUP BY ticker)
        AND u.is_active = 1
        AND s.earnings_date IS NOT NULL
        AND s.earnings_date >= ?
        AND s.earnings_date <= ?
        ORDER BY s.earnings_date ASC
      `).all(todayStr, cutoffStr) as any[];

      // Get all watchlist tickers for flagging
      const watchlists = rawSqlite.prepare("SELECT tickers FROM watchlists").all() as any[];
      const watchlistSet = new Set<string>();
      for (const wl of watchlists) {
        try { const tickers: string[] = JSON.parse(wl.tickers); tickers.forEach((t) => watchlistSet.add(t)); } catch { /* skip */ }
      }

      res.json(rows.map((r) => ({
        ticker: r.ticker,
        stockName: r.stock_name,
        sector: r.sector,
        compositeScore: r.composite_score,
        signal20d: r.signal_20d,
        earningsDate: r.earnings_date,
        price: r.price,
        changePct: r.change_pct,
        confidence20d: r.confidence_20d,
        isWatchlisted: watchlistSet.has(r.ticker),
      })));
    } catch (err) {
      logError("earnings", "Failed to fetch earnings calendar", err);
      res.status(500).json({ error: "Failed to fetch earnings calendar", detail: String(err) });
    }
  });

  // ─── Insider Transactions ──────────────────────────────────────────────────

  // GET /api/insider/:ticker — returns stored insider transactions
  app.get("/api/insider/:ticker", requireAuth, async (req: Request, res: Response) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const rows = rawSqlite.prepare(`
        SELECT ticker, filed_at, transaction_date, insider_name, relation,
               transaction_type, shares, value, fetched_at
        FROM insider_transactions
        WHERE ticker = ?
        ORDER BY COALESCE(transaction_date, filed_at) DESC
        LIMIT 5
      `).all(ticker) as any[];
      res.json(rows.map((r) => ({
        ticker: r.ticker,
        filedAt: r.filed_at,
        transactionDate: r.transaction_date,
        insiderName: r.insider_name,
        relation: r.relation,
        transactionType: r.transaction_type,
        shares: r.shares,
        value: r.value,
        fetchedAt: r.fetched_at,
      })));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch insider transactions", detail: String(err) });
    }
  });

  // POST /api/insider/:ticker/refresh — fetch from Yahoo and store (watchlist use only)
  app.post("/api/insider/:ticker/refresh", requireWriteAuth, async (req: Request, res: Response) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const axios2 = (await import("axios")).default;
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

      // Get crumb via fc.yahoo.com
      let cookieStr = "";
      let crumb: string | null = null;
      try {
        const fcResp = await axios2.get("https://fc.yahoo.com", {
          headers: { "User-Agent": UA }, timeout: 8000, maxRedirects: 3, validateStatus: () => true,
        });
        const setCookie = fcResp.headers["set-cookie"] as string[] | string | undefined;
        const cookies: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        cookieStr = cookies.map((c: string) => c.split(";")[0].trim()).filter(Boolean).join("; ");
        if (cookieStr) {
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
            const crumbResp = await axios2.get("https://query1.finance.yahoo.com/v1/test/getcrumb", {
              headers: { "User-Agent": UA, "Cookie": cookieStr }, timeout: 8000, validateStatus: () => true,
            });
            const raw = typeof crumbResp.data === "string" ? crumbResp.data.trim() : null;
            if (raw && !raw.startsWith("{") && !raw.includes(" ") && raw.length <= 50) { crumb = raw; break; }
          }
        }
      } catch { /* crumb unavailable */ }

      const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
      const summUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=insiderTransactions${crumbParam}`;
      const summResp = await axios2.get(summUrl, {
        headers: { "User-Agent": UA, "Cookie": cookieStr },
        timeout: 12000, validateStatus: () => true,
      });

      if (summResp.status !== 200) {
        return res.status(502).json({ error: `Yahoo returned ${summResp.status}`, body: JSON.stringify(summResp.data).slice(0, 200) });
      }

      const txns = summResp.data?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions ?? [];
      const fetchedAt = new Date().toISOString();

      // Delete old rows for this ticker and insert up to 5 most recent
      rawSqlite.prepare("DELETE FROM insider_transactions WHERE ticker = ?").run(ticker);
      const insertStmt = rawSqlite.prepare(`
        INSERT INTO insider_transactions (ticker, filed_at, transaction_date, insider_name, relation, transaction_type, shares, value, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const recent = txns.slice(0, 5);
      for (const t of recent) {
        const sharesRaw: number | null = t.shares?.raw ?? null;
        const valueRaw: number | null = t.value?.raw ?? null;
        const desc: string = (t.transactionDescription ?? "").toLowerCase();
        let transactionType: string | null = t.transactionDescription ?? null;
        if (!transactionType) {
          if (sharesRaw != null && sharesRaw > 0 && valueRaw != null && valueRaw > 0) {
            transactionType = "Purchase";
          } else if (sharesRaw != null && sharesRaw < 0) {
            transactionType = "Sale";
          }
        }
        const isOpenMarketBuy =
          (desc ? /purchase|open.?market/.test(desc) && !/sale|exercise|gift|option/.test(desc) : false) ||
          (transactionType === "Purchase" && !desc.includes("option") && !desc.includes("exercise"))
            ? 1 : 0;
        insertStmt.run(
          ticker,
          t.startDate?.fmt ?? null,
          t.startDate?.fmt ?? null,
          t.filerName ?? null,
          t.filerRelation ?? null,
          transactionType,
          sharesRaw,
          valueRaw,
          fetchedAt,
        );
      }

      res.json({ ticker, fetched: recent.length, fetchedAt });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch insider transactions", detail: String(err) });
    }
  });

  // GET /api/signals — recent insider transactions (last 30 days)
  // Buys = transaction_type contains 'Purchase' or 'Buy' (case-insensitive)
  // Sells = transaction_type contains 'Sale' (only returned when value > $100K threshold)
  app.get("/api/signals", requireAuth, (req: Request, res: Response) => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      // Buys: open-market purchases (transaction_type like Purchase/Buy)
      const buyRows = rawSqlite.prepare(`
        SELECT it.ticker, it.transaction_date, it.insider_name, it.relation,
               it.transaction_type, it.shares, it.value, it.fetched_at,
               u.name AS stock_name, u.sector,
               'buy' AS signal_kind
        FROM insider_transactions it
        LEFT JOIN universe u ON u.ticker = it.ticker
        WHERE (it.transaction_type LIKE '%Purchase%' OR it.transaction_type LIKE '%Buy%')
          AND it.transaction_type NOT LIKE '%Option%'
          AND it.transaction_date >= ?
        ORDER BY it.transaction_date DESC, it.value DESC
        LIMIT 200
      `).all(cutoff) as any[];

      // Sells: only surface when value >= $100K (sell warnings)
      const SELL_THRESHOLD = 100_000;
      const sellRows = rawSqlite.prepare(`
        SELECT it.ticker, it.transaction_date, it.insider_name, it.relation,
               it.transaction_type, it.shares, it.value, it.fetched_at,
               u.name AS stock_name, u.sector,
               'sell' AS signal_kind
        FROM insider_transactions it
        LEFT JOIN universe u ON u.ticker = it.ticker
        WHERE (it.transaction_type LIKE '%Sale%' OR it.transaction_type LIKE '%Sell%')
          AND it.transaction_type NOT LIKE '%Option%'
          AND it.transaction_date >= ?
          AND it.value >= ?
        ORDER BY it.transaction_date DESC, it.value DESC
        LIMIT 100
      `).all(cutoff, SELL_THRESHOLD) as any[];

      // Compute per-ticker buy count for "multiple insiders" banner
      const buyCounts: Record<string, number> = {};
      for (const r of buyRows) {
        buyCounts[r.ticker] = (buyCounts[r.ticker] ?? 0) + 1;
      }

      const enriched = (rows: any[], kind: string) =>
        rows.map((r) => ({
          ...r,
          signal_kind: kind,
          multi_insider: kind === 'buy' ? (buyCounts[r.ticker] ?? 1) > 1 : false,
          large_purchase: kind === 'buy' && r.value != null && r.value >= 500_000,
        }));

      const lastUpdated = rawSqlite.prepare(
        "SELECT MAX(fetched_at) AS ts FROM insider_transactions WHERE transaction_date >= ?"
      ).get(cutoff) as { ts: string | null };

      res.json({
        buys: enriched(buyRows, 'buy'),
        sells: enriched(sellRows, 'sell'),
        lastUpdated: lastUpdated?.ts ?? null,
        cutoffDate: cutoff,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch signals", detail: String(err) });
    }
  });

  // GET /api/admin/disk-usage — returns volume and DB file size stats
  app.get("/api/admin/disk-usage", requireAdminAuth, (_req: Request, res: Response) => {
    try {
      res.json(getDiskStats());
    } catch (err) {
      res.status(500).json({ error: "Failed to read disk stats", detail: String(err) });
    }
  });

  // POST /api/admin/prune — manually trigger pruning + WAL checkpoint
  app.post("/api/admin/prune", requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      const result = runPrune();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Prune failed", detail: String(err) });
    }
  });

  // POST /api/admin/wal-checkpoint — force WAL checkpoint immediately
  app.post("/api/admin/wal-checkpoint", requireAdminAuth, (_req: Request, res: Response) => {
    try {
      walCheckpoint();
      res.json({ success: true, stats: getDiskStats() });
    } catch (err) {
      res.status(500).json({ error: "Checkpoint failed", detail: String(err) });
    }
  });

  // POST /api/admin/backfill-coverage — Fix #11B: re-score all recommendations using stored
  // snapshots to populate missing fundamentals and recalculate coverage tiers.
  // Run once after deploying Fix #11/#12 to upgrade existing data.
  app.post("/api/admin/backfill-coverage", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { rankMultiple: rm } = await import("./lib/rankingEngine");
      const { applyStoredFallbacks: asf } = await import("./lib/dataFetcher");
      const strictness = (await storage.getSetting("strictness")) || "balanced";
      const activeStocks = await storage.getActiveUniverseStocks();
      let updated = 0, skipped = 0, errors = 0;

      for (const stock of activeStocks) {
        try {
          const snap = await storage.getLatestSnapshot(stock.ticker);
          if (!snap || !snap.price) { skipped++; continue; }
          // Convert PriceSnapshot back to RawStockData-like shape
          const raw = asf(
            {
              ticker: stock.ticker,
              source: snap.dataSource,
              freshness: snap.dataFreshness as any,
              fetchedAt: snap.fetchedAt,
              price: snap.price ?? undefined,
              pe: snap.pe ?? undefined,
              pb: snap.pb ?? undefined,
              eps: snap.eps ?? undefined,
              epsGrowthYoy: snap.epsGrowthYoy ?? undefined,
              revenueGrowthYoy: snap.revenueGrowthYoy ?? undefined,
              grossMargin: snap.grossMargin ?? undefined,
              operatingMargin: snap.operatingMargin ?? undefined,
              roe: snap.roe ?? undefined,
              debtEquity: snap.debtEquity ?? undefined,
              freeCashFlow: snap.freeCashFlow ?? undefined,
              dividendYield: snap.dividendYield ?? undefined,
              evEbitda: snap.evEbitda ?? undefined,
              analystBuy: snap.analystBuy ?? undefined,
              analystHold: snap.analystHold ?? undefined,
              analystSell: snap.analystSell ?? undefined,
              priceTarget: snap.priceTarget ?? undefined,
              earningsDate: snap.earningsDate ?? undefined,
              beta: snap.beta ?? undefined,
              marketCap: undefined,
              ret20d: snap.ret20d ?? undefined,
              ret60d: snap.ret60d ?? undefined,
              ret120d: snap.ret120d ?? undefined,
              ret250d: snap.ret250d ?? undefined,
              sma20: snap.sma20 ?? undefined,
              sma50: snap.sma50 ?? undefined,
              sma200: snap.sma200 ?? undefined,
              rsi14: snap.rsi14 ?? undefined,
              macd: snap.macd ?? undefined,
              atr14: snap.atr14 ?? undefined,
              high52w: snap.high52w ?? undefined,
              low52w: snap.low52w ?? undefined,
              volume: snap.volume ?? undefined,
              avgVolume20d: snap.avgVolume20d ?? undefined,
            },
            null // no additional stored fallback needed; snap IS the stored data
          );
          const [ranking] = rm(
            [raw],
            strictness,
            [{ sector: stock.sector, assetType: stock.assetType }]
          );
          await storage.saveRecommendation(ranking, snap.id);
          updated++;
        } catch { errors++; }
        // Brief pause to avoid thrashing the DB
        await new Promise((r) => setTimeout(r, 5));
      }

      res.json({ success: true, updated, skipped, errors, total: activeStocks.length });
    } catch (err) {
      res.status(500).json({ error: "Backfill failed", detail: String(err) });
    }
  });

  // POST /api/admin/backfill-names — fix stocks where name = ticker or name is null
  // Fetches Yahoo Finance data for each affected stock and updates to longName/shortName.
  // Rate-limited to ~1/400ms. Returns { checked, fixed, failed }.
  app.post("/api/admin/backfill-names", requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      const activeStocks = await storage.getActiveUniverseStocks();
      const needsFix = (s: { name: string; ticker: string }) => {
        const n = (s.name ?? "").trim();
        return !n || n === s.ticker || /^[\d\s.]+$/.test(n);
      };
      const toFix = activeStocks.filter(needsFix);
      logInfo("backfill-names", `Found ${toFix.length} tickers needing name fix (out of ${activeStocks.length} active)`);

      const alphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;
      let fixed = 0, failed = 0;

      for (let i = 0; i < toFix.length; i++) {
        const stock = toFix[i];
        try {
          const raw = await fetchStockData(stock.ticker, alphaVantageKey);
          // Do NOT touch Asian tickers — their names are already correct
          const isAsian = /\.(KS|KQ|T|HK|SS|SZ|TW|BO|NS|BK|KL|SI|JK|PS)$/.test(stock.ticker);
          if (isAsian) { fixed++; continue; } // count as "handled", skip update
          const newName = raw.longName || raw.shortName || (raw as any).displayName || raw.quoteType;
          if (newName && newName !== stock.ticker) {
            await storage.updateUniverseName(stock.ticker, newName);
            fixed++;
            logInfo("backfill-names", `Fixed ${stock.ticker}: "${stock.name}" -> "${newName}"`);
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        if (i + 1 < toFix.length) await new Promise((r) => setTimeout(r, 400));
      }

      res.json({ success: true, checked: toFix.length, fixed, failed });
    } catch (err) {
      logError("backfill-names", "Failed", err);
      res.status(500).json({ error: "Backfill names failed", detail: String(err) });
    }
  });

  // POST /api/admin/emergency-cleanup — purges duplicate recommendations when disk is full.
  // Uses PRAGMA journal_mode=OFF so it works even with zero free disk space.
  // Protected by ADMIN_PASSWORD query param (no DB write needed for auth).
  app.post("/api/admin/emergency-cleanup", async (req: Request, res: Response) => {
    const provided = (req.query.password || req.body?.password) as string | undefined;
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected || provided !== expected) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      rawSqlite.exec("PRAGMA journal_mode=OFF");
      rawSqlite.exec("PRAGMA synchronous=OFF");
      const before = (rawSqlite.prepare("SELECT COUNT(*) as cnt FROM recommendations").get() as any).cnt;
      let totalDeleted = 0;
      for (let pass = 0; pass < 1000; pass++) {
        const result = rawSqlite.prepare(`
          DELETE FROM recommendations WHERE id IN (
            SELECT r.id FROM recommendations r
            WHERE r.id != (SELECT MAX(id) FROM recommendations r2 WHERE r2.ticker = r.ticker)
            LIMIT 2000
          )
        `).run();
        totalDeleted += result.changes;
        if (result.changes === 0) break;
      }
      const after = (rawSqlite.prepare("SELECT COUNT(*) as cnt FROM recommendations").get() as any).cnt;
      let vacuumMsg = "skipped";
      try { rawSqlite.exec("VACUUM"); vacuumMsg = "ok"; } catch (e) { vacuumMsg = String(e); }
      // Restore WAL mode after cleanup
      try { rawSqlite.exec("PRAGMA journal_mode=WAL"); rawSqlite.exec("PRAGMA synchronous=NORMAL"); } catch {}
      // Mark cleanup done
      rawSqlite.exec(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('migration_recs_cleanup_v3', '1', datetime('now'))`);
      res.json({ before, after, totalDeleted, vacuum: vacuumMsg });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/insider/bulk-refresh — manual trigger
  app.post("/api/insider/bulk-refresh", requireWriteAuth, async (req: Request, res: Response) => {
    res.json({ message: "Insider bulk refresh started", running: true });
    runInsiderBulkRefresh().catch((e) =>
      console.error("[InsiderRefresh] Bulk refresh error:", e)
    );
  });

  const savedInterval = await storage.getSetting("refresh_interval");
  const interval = savedInterval ? parseInt(savedInterval) : 15;
  startScheduler(interval as any);
  logInfo("startup", `Auto-started scheduler with ${interval}min interval`);

  // Print all registered API routes at startup (per user requirement)
  setTimeout(() => {
    const registeredRoutes: string[] = [];
    (app as any)._router?.stack?.forEach((layer: any) => {
      if (layer.route?.path) {
        const methods = Object.keys(layer.route.methods).map((m: string) => m.toUpperCase()).join(",");
        registeredRoutes.push(`  ${methods.padEnd(7)} ${layer.route.path}`);
      }
    });
    if (registeredRoutes.length > 0) {
      logInfo("startup", `Registered ${registeredRoutes.length} API routes:\n${registeredRoutes.join("\n")}`);
    }
  }, 500);

  // ── Global error handler (catch-all — logs full detail, returns generic message) ───────
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logError("global", `Unhandled error on ${req.method} ${req.path}`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong." });
    }
  });
}

// ─── Admin Panel HTML helpers (SSR) ──────────────────────────────────────────

function adminBase(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Stock Recommender Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 1.5rem; }
  .card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 0.75rem; padding: 1.5rem; max-width: 780px; margin: 0 auto; }
  h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 1.25rem; color: #e2e8f0; }
  h2 { font-size: 0.95rem; font-weight: 600; color: #94a3b8; margin-bottom: 0.75rem; margin-top: 1.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
  label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.3rem; }
  input[type=text], input[type=password] { width: 100%; background: #0f1117; border: 1px solid #2d3748; border-radius: 0.375rem; padding: 0.5rem 0.75rem; color: #e2e8f0; font-size: 0.875rem; outline: none; }
  input:focus { border-color: #3b82f6; }
  .btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 1rem; border-radius: 0.375rem; font-size: 0.8rem; font-weight: 600; cursor: pointer; border: none; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-danger { background: #ef4444; color: white; }
  .btn-ghost { background: #2d3748; color: #e2e8f0; }
  .error { background: #7f1d1d40; border: 1px solid #ef4444; border-radius: 0.375rem; padding: 0.6rem 0.9rem; color: #fca5a5; font-size: 0.85rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; color: #64748b; font-weight: 600; border-bottom: 1px solid #2d3748; }
  td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #1e293b; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
  .badge-active { background: #14532d40; color: #86efac; border: 1px solid #166534; }
  .badge-revoked { background: #1f2937; color: #6b7280; border: 1px solid #374151; }
  .link-box { font-family: monospace; font-size: 0.72rem; background: #0f1117; border: 1px solid #2d3748; border-radius: 0.25rem; padding: 0.3rem 0.5rem; color: #60a5fa; word-break: break-all; }
  .copy-btn { font-size: 0.7rem; background: #1e3a5f; color: #93c5fd; border: none; border-radius: 0.25rem; padding: 0.2rem 0.5rem; cursor: pointer; }
  .copy-btn:hover { background: #2563eb; color: white; }
  .flex { display: flex; align-items: center; gap: 0.5rem; }
  .mt-2 { margin-top: 0.5rem; }
  .form-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  .form-row input { flex: 1; }
</style>
</head>
<body>
${body}
<script>
function copyLink(id) {
  const el = document.getElementById(id);
  if (el) { navigator.clipboard.writeText(el.textContent.trim()); }
}
</script>
</body>
</html>`;
}

/** After successful admin login, store ADMIN_PASSWORD in sessionStorage and navigate to /admin */
function adminLoginSuccessHtml(adminPassword: string): string {
  // Base64-encode the password to avoid URL special characters (# / ? etc.)
  // The adminToken URL param is only used server-side to authenticate GET /admin;
  // actual API calls from the panel use the Bearer header from sessionStorage.
  const b64token = Buffer.from(adminPassword).toString('base64url');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Redirecting…</title>
<style>body{background:#0f1117;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>
</head>
<body>
<p>Signing in…</p>
<script>
  // Store password in sessionStorage — used by admin panel JS for API calls via Bearer header
  try { sessionStorage.setItem('admin_password', ${JSON.stringify(adminPassword)}); } catch(e) {}
  // Navigate to /admin with base64-encoded token (safe in URL, no # truncation)
  window.location.replace('/admin?adminToken=${b64token}');
</script>
</body>
</html>`;
}

/** Logout page: clear sessionStorage and redirect to login */
function adminLogoutHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Signing out…</title>
<style>body{background:#0f1117;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>
</head>
<body>
<p>Signing out…</p>
<script>
  // Clear the correct sessionStorage key (admin_password, not admin_jwt)
  try { sessionStorage.removeItem('admin_password'); } catch(e) {}
  try { sessionStorage.removeItem('admin_jwt'); } catch(e) {} // legacy key
  window.location.replace('/admin/login');
</script>
</body>
</html>`;
}

function adminLoginHtml(error?: string): string {
  return adminBase("Login", `
<div class="card">
  <h1>Admin Login</h1>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/admin/login">
    <label for="password">Admin Password</label>
    <input type="password" id="password" name="password" autofocus placeholder="Enter ADMIN_PASSWORD" />
    <div class="mt-2">
      <button type="submit" class="btn btn-primary">Sign In</button>
    </div>
  </form>
</div>`);
}

function adminErrorHtml(msg: string): string {
  return adminBase("Error", `<div class="card"><div class="error">${msg}</div></div>`);
}

function adminPanelHtml(links: any[], baseUrl: string, adminToken: string = ""): string {
  const linkRows = links.map((l) => {
    const typeLabel = l.type === "admin" ? "<span style='color:#60a5fa'>admin</span>" : "<span style='color:#a3e635'>viewer</span>";
    return `
<tr>
  <td>${l.label || "<em style='color:#64748b'>—</em>"}</td>
  <td>${typeLabel}</td>
  <td><span class="badge ${l.isActive ? "badge-active" : "badge-revoked"}">${l.isActive ? "Active" : "Revoked"}</span></td>
  <td style="color:#94a3b8;font-size:0.75rem">${l.createdAt ? l.createdAt.substring(0, 10) : "—"}</td>
  <td style="color:#94a3b8;font-size:0.75rem">${l.lastUsedAt ? l.lastUsedAt.substring(0, 10) : "Never"}</td>
  <td>
    ${l.isActive ? `<button class="btn btn-danger" onclick="revokeLink('${l._id}', this)">Revoke</button>` : ""}
  </td>
</tr>`;
  }).join("");

  return adminBase("Admin", `
<div class="card">
  <div class="flex" style="justify-content:space-between;margin-bottom:1.25rem">
    <h1 style="margin:0">Access Link Manager</h1>
    <a href="/admin/logout" class="btn btn-ghost" style="text-decoration:none">Sign Out</a>
  </div>

  <h2>Create New Access Link</h2>
  <div class="form-row" style="margin-top:0.75rem">
    <input type="text" id="new-label" placeholder="Label (e.g. Alice, Team)" style="flex:1;background:#0f1117;border:1px solid #2d3748;border-radius:0.375rem;padding:0.5rem 0.75rem;color:#e2e8f0;font-size:0.875rem;" />
    <button class="btn btn-primary" onclick="createLink('admin')">+ Admin Link</button>
    <button class="btn btn-ghost" style="border:1px solid #3b82f6;color:#60a5fa" onclick="createLink('viewer')">+ Viewer Link</button>
  </div>

  <div id="new-link-result" style="margin-top:0.75rem;display:none">
    <div style="background:#1e3a5f;border:1px solid #2563eb;border-radius:0.5rem;padding:1rem">
      <p style="color:#93c5fd;font-size:0.8rem;margin-bottom:0.5rem">⚠️ This link will not be shown again. Copy it now.</p>
      <div class="link-box" id="new-link-url" style="word-break:break-all;margin-bottom:0.5rem"></div>
      <button class="copy-btn" onclick="copyNewLink()">Copy Link</button>
    </div>
  </div>

  <!-- Disk Usage Card (loaded async by JS) -->
  <div class="card" style="margin-top:1.25rem" id="disk-card">
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:0.75rem">
      <h2 style="margin:0">Disk &amp; Storage</h2>
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-ghost" onclick="loadDiskStats()" id="disk-refresh-btn" style="font-size:0.75rem;padding:0.25rem 0.75rem">Refresh</button>
        <button class="btn btn-danger" onclick="runPrune()" id="prune-btn" style="font-size:0.75rem;padding:0.25rem 0.75rem">Prune Now</button>
        <button class="btn btn-ghost" onclick="runWalCheckpoint()" id="wal-btn" style="font-size:0.75rem;padding:0.25rem 0.75rem">WAL Checkpoint</button>
      </div>
    </div>
    <div id="disk-stats" style="color:#94a3b8;font-size:0.85rem">Loading…</div>
  </div>

  <h2 style="margin-top:1.5rem">All Access Links (${links.length})</h2>
  ${links.length === 0 ? `<p style="color:#64748b;font-size:0.85rem">No access links yet. Create one above.</p>` : `
  <table>
    <thead>
      <tr>
        <th>Label</th><th>Type</th><th>Status</th><th>Created</th><th>Last Used</th><th></th>
      </tr>
    </thead>
    <tbody>${linkRows}</tbody>
  </table>`}
</div>
<script>
  var _adminToken = '';
  try { _adminToken = sessionStorage.getItem('admin_password') || ''; } catch(e) {}
  // Fallback: decode base64url adminToken from URL param (set by login redirect)
  if (!_adminToken) {
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('adminToken') || '';
      if (raw) {
        // Try base64url decode first, then fall back to raw value
        try {
          _adminToken = atob(raw.replace(/-/g,'+').replace(/_/g,'/'));
        } catch(e2) {
          _adminToken = raw;
        }
        // Store decoded value in sessionStorage for subsequent calls
        try { sessionStorage.setItem('admin_password', _adminToken); } catch(e3) {}
        // Strip the token from the URL bar to avoid it being bookmarked/shared
        history.replaceState(null, '', '/admin');
      }
    } catch(e) {}
  }
  if (!_adminToken) {
    // No token found at all — sessionStorage may have been cleared (browser restart)
    // Redirect to login so the user re-authenticates
    window.location.replace('/admin/login');
  }

  function getHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _adminToken };
  }

  // ── Disk stats ────────────────────────────────────────────────────
  function loadDiskStats() {
    var el = document.getElementById('disk-stats');
    el.textContent = 'Loading…';
    fetch('/api/admin/disk-usage', { headers: getHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) { el.textContent = 'Error: ' + d.error; return; }
        var pct = d.percent_used;
        var barColor = pct >= 95 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
        var totalDisp = d.total_mb > 0 ? (d.used_mb + ' MB / ' + d.total_mb + ' MB (' + pct + '%)') : 'n/a';
        el.innerHTML =
          '<div style="margin-bottom:0.75rem">' +
          (d.total_mb > 0 ?
            '<div style="background:#1e293b;border-radius:999px;height:8px;width:100%;overflow:hidden;margin-bottom:0.5rem">' +
            '<div style="height:100%;border-radius:999px;background:' + barColor + ';width:' + Math.min(pct,100) + '%"></div></div>' : '') +
          '<div style="display:flex;gap:2rem;flex-wrap:wrap">' +
          '<span>💾 Volume: ' + totalDisp + '</span>' +
          '<span>DB file: ' + d.db_size_mb + ' MB</span>' +
          '<span>WAL file: ' + d.wal_size_mb + ' MB</span>' +
          '<span>Free: ' + d.free_mb + ' MB</span>' +
          '</div>' +
          (pct >= 95 ? '<div style="color:#ef4444;margin-top:0.4rem;font-weight:600">⚠️ CRITICAL: disk at ' + pct + '% — prune immediately</div>' : '') +
          (pct >= 80 && pct < 95 ? '<div style="color:#f59e0b;margin-top:0.4rem">⚠️ WARNING: disk at ' + pct + '%</div>' : '') +
          '</div>';
      })
      .catch(function(e) { document.getElementById('disk-stats').textContent = 'Failed: ' + e.message; });
  }

  function runPrune() {
    if (!confirm('Run database pruning now? This will delete old logs, signals, and earnings data, then run a WAL checkpoint.')) return;
    var btn = document.getElementById('prune-btn');
    btn.disabled = true; btn.textContent = 'Pruning…';
    fetch('/api/admin/prune', { method: 'POST', headers: getHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        btn.disabled = false; btn.textContent = 'Prune Now';
        if (d.error) { alert('Prune error: ' + d.error); return; }
        var msg = 'Prune complete.'; msg += String.fromCharCode(10) + 'Recs deleted: ' + d.recommendations_deleted; msg += String.fromCharCode(10) + 'Logs deleted: ' + d.refresh_log_deleted; msg += String.fromCharCode(10) + 'Backtests deleted: ' + d.backtest_deleted; msg += String.fromCharCode(10) + 'Signals deleted: ' + d.signals_deleted; msg += String.fromCharCode(10) + 'Earnings deleted: ' + d.earnings_deleted; msg += String.fromCharCode(10) + 'WAL checkpointed: ' + d.wal_checkpointed; msg += String.fromCharCode(10) + 'Disk before: ' + d.stats_before.percent_used + '% -> after: ' + d.stats_after.percent_used + '%'; alert(msg);
        loadDiskStats();
      })
      .catch(function(e) { btn.disabled = false; btn.textContent = 'Prune Now'; alert('Failed: ' + e.message); });
  }

  function runWalCheckpoint() {
    var btn = document.getElementById('wal-btn');
    btn.disabled = true; btn.textContent = 'Running…';
    fetch('/api/admin/wal-checkpoint', { method: 'POST', headers: getHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        btn.disabled = false; btn.textContent = 'WAL Checkpoint';
        if (d.error) { alert('Error: ' + d.error); return; }
        loadDiskStats();
      })
      .catch(function(e) { btn.disabled = false; btn.textContent = 'WAL Checkpoint'; alert('Failed: ' + e.message); });
  }

  // Load disk stats immediately on page load
  loadDiskStats();

  // ── Access links ───────────────────────────────────────────────
  function createLink(type) {
    var label = document.getElementById('new-label').value.trim() || 'Unnamed';
    fetch('/api/admin/links', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ label, type })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) { alert('Error: ' + data.error); return; }
      var resultDiv = document.getElementById('new-link-result');
      var urlEl = document.getElementById('new-link-url');
      urlEl.textContent = data.url;
      resultDiv.style.display = 'block';
      // Reload table after short delay
      setTimeout(function() { window.location.reload(); }, 3000);
    }).catch(function(e) { alert('Failed: ' + e.message); });
  }

  function copyNewLink() {
    var url = document.getElementById('new-link-url').textContent.trim();
    navigator.clipboard.writeText(url).catch(function() {
      prompt('Copy this link:', url);
    });
  }

  function revokeLink(id, btn) {
    if (!confirm('Revoke this access link? It will stop working immediately.')) return;
    btn.disabled = true;
    btn.textContent = 'Revoking…';
    fetch('/api/admin/links/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: getHeaders()
    }).then(function(r) {
      if (r.status === 401) {
        // Session expired — redirect to login
        window.location.replace('/admin/login');
        return Promise.reject(new Error('Session expired'));
      }
      return r.json();
    }).then(function(data) {
      if (data.error) {
        alert('Error revoking link: ' + data.error);
        btn.disabled = false;
        btn.textContent = 'Revoke';
        return;
      }
      // Success: update the row immediately without full reload
      var row = btn.closest('tr');
      if (row) {
        var statusCell = row.querySelector('.badge');
        if (statusCell) {
          statusCell.className = 'badge badge-revoked';
          statusCell.textContent = 'Revoked';
        }
        btn.remove();
      } else {
        window.location.reload();
      }
    }).catch(function(e) {
      if (e.message !== 'Session expired') {
        alert('Failed to revoke: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Revoke';
      }
    });
  }
</script>`);
}
