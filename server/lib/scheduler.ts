/**
 * Refresh Scheduler — upgraded for 1600+ stock universe
 * - Batched fetching with configurable concurrency
 * - Rate limiting with delays between batches
 * - Automatic retries on transient failures
 * - Live progress tracking via module-level state
 * - Opportunity scoring computed alongside main refresh
 */

import cron from "node-cron";
import { storage, rawSqlite as sqlite } from "../storage";
import { fetchStockData, applyStoredFallbacks } from "./dataFetcher";
import { rankMultiple } from "./rankingEngine";
import { computeOpportunityScore } from "./opportunityEngine";
import { classifySector } from "./sectorClassifier";
import type { RawStockData } from "./dataFetcher";

// ─── Error categorisation ──────────────────────────────────────────────────────
export type FailureCategory = "rate_limited" | "not_found" | "missing_price" | "network_timeout" | "unknown";

export function categoriseError(raw: RawStockData): FailureCategory {
  if (!raw.error) return "unknown";
  const e = raw.error.toLowerCase();
  if (e.includes("429") || e.includes("503") || e.includes("rate") || e.includes("throttl")) return "rate_limited";
  if (e.includes("404") || e.includes("not found") || e.includes("no data") || e.includes("empty chart")) return "not_found";
  if (e.includes("timeout") || e.includes("econnreset") || e.includes("econnrefused") || e.includes("network")) return "network_timeout";
  if (raw.price == null && !raw.error) return "missing_price";
  return "unknown";
}

export type RefreshInterval = 5 | 15 | 30 | 60;

// Exchange trading hours in UTC
const EXCHANGE_HOURS: Record<string, { open: number; close: number; days: number[] }> = {
  NYSE:    { open: 14, close: 21, days: [1, 2, 3, 4, 5] },
  NASDAQ:  { open: 14, close: 21, days: [1, 2, 3, 4, 5] },
  XETRA:  { open: 7, close: 17, days: [1, 2, 3, 4, 5] },
  LSE:    { open: 8, close: 16, days: [1, 2, 3, 4, 5] },
  EURONEXT: { open: 7, close: 17, days: [1, 2, 3, 4, 5] },
  TSX:    { open: 14, close: 21, days: [1, 2, 3, 4, 5] },
  TSE:    { open: 0, close: 6, days: [1, 2, 3, 4, 5] },
  HKEX:   { open: 1, close: 8, days: [1, 2, 3, 4, 5] },
  ASX:    { open: 23, close: 6, days: [1, 2, 3, 4, 5] },
  NSE:    { open: 3, close: 10, days: [1, 2, 3, 4, 5] },
  KRX:    { open: 0, close: 7, days: [1, 2, 3, 4, 5] },
  TWSE:   { open: 1, close: 6, days: [1, 2, 3, 4, 5] },
  DEFAULT: { open: 7, close: 22, days: [1, 2, 3, 4, 5] },
};

export function isMarketOpen(exchange: string): boolean {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const hour = now.getUTCHours();
  const hours = EXCHANGE_HOURS[exchange] || EXCHANGE_HOURS.DEFAULT;
  if (!hours.days.includes(dayOfWeek)) return false;
  return hour >= hours.open && hour < hours.close;
}

export function anyMarketOpen(): boolean {
  return Object.keys(EXCHANGE_HOURS).some(
    (ex) => ex !== "DEFAULT" && isMarketOpen(ex)
  );
}

// ─── Progress tracking (module-level, read by /api/refresh/progress) ─────────
export interface RefreshProgress {
  isRefreshing: boolean;
  total: number;
  fetched: number;
  succeeded: number;
  failed: number;
  currentBatch: number;
  totalBatches: number;
  startedAt: string | null;
  estimatedSecondsRemaining: number | null;
  phase: "idle" | "fetching" | "scoring" | "saving" | "done";
}

let _progress: RefreshProgress = {
  isRefreshing: false,
  total: 0,
  fetched: 0,
  succeeded: 0,
  failed: 0,
  currentBatch: 0,
  totalBatches: 0,
  startedAt: null,
  estimatedSecondsRemaining: null,
  phase: "idle",
};

export function getRefreshProgress(): RefreshProgress {
  return { ..._progress };
}

function updateProgress(patch: Partial<RefreshProgress>) {
  _progress = { ..._progress, ...patch };
}

// ─── Retry helper (exponential backoff for rate limits) ────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === retries) throw err;
      const isRateLimit = err?.response?.status === 429 || err?.response?.status === 503;
      // Exponential backoff: 1s, 2s, 4s — triple if rate-limited
      const waitMs = isRateLimit
        ? baseDelayMs * Math.pow(3, attempt + 1)  // 3s, 9s, 27s
        : baseDelayMs * Math.pow(2, attempt);      // 1s, 2s, 4s
      console.log(`[Scheduler] Retry ${attempt + 1}/${retries} after ${waitMs}ms (${isRateLimit ? 'rate-limited' : 'error'})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error("Max retries exceeded");
}

let scheduledTask: cron.ScheduledTask | null = null;
let currentInterval: RefreshInterval = 15;

export async function runRefresh(triggerType: "manual" | "scheduled" = "scheduled"): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  if (_progress.isRefreshing) {
    console.log("[Scheduler] Refresh already in progress, skipping");
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const startedAt = new Date().toISOString();
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  updateProgress({
    isRefreshing: true,
    total: 0,
    fetched: 0,
    succeeded: 0,
    failed: 0,
    currentBatch: 0,
    totalBatches: 0,
    startedAt,
    phase: "fetching",
  });

  try {
    const activeStocks = await storage.getActiveUniverseStocks();
    const allTickers = activeStocks.map((s) => s.ticker);
    attempted = allTickers.length;

    if (allTickers.length === 0) {
      console.log("[Scheduler] No tickers in universe");
      updateProgress({ isRefreshing: false, phase: "done" });
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    // Build a lookup for metadata (name, sector, industry, assetType, region)
    const stockMeta = Object.fromEntries(
      activeStocks.map((s) => [
        s.ticker,
        { name: s.name, sector: s.sector, industry: s.industry, region: s.region, assetType: s.assetType },
      ])
    );

    console.log(`[Scheduler] Refreshing ${allTickers.length} tickers...`);
    const alphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;

    // ── Batched fetch configuration ────────────────────────────────────────
    // For large universes: 8 concurrent, 600ms between batches, 2 retries
    const BATCH_SIZE = 8;
    const BATCH_DELAY_MS = 600;
    const RETRY_COUNT = 2;

    const totalBatches = Math.ceil(allTickers.length / BATCH_SIZE);
    updateProgress({ total: allTickers.length, totalBatches });

    const allRawData: any[] = [];
    const startTime = Date.now();

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batch = allTickers.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
      updateProgress({ currentBatch: batchIndex + 1 });

      // Fetch batch with retries
      const batchResults = await Promise.all(
        batch.map((ticker) =>
          withRetry(
            () => fetchStockData(ticker, alphaVantageKey),
            RETRY_COUNT,
            800
          ).catch((err) => ({
            ticker,
            source: "error",
            freshness: "eod" as const,
            fetchedAt: new Date().toISOString(),
            error: err?.message || "Fetch failed after retries",
          }))
        )
      );

      allRawData.push(...batchResults);

      const fetchedSoFar = Math.min((batchIndex + 1) * BATCH_SIZE, allTickers.length);
      updateProgress({ fetched: fetchedSoFar });

      // Estimate remaining time
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = fetchedSoFar / elapsed;
      const remaining = allTickers.length - fetchedSoFar;
      const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
      updateProgress({ estimatedSecondsRemaining: etaSec });

      // Rate limit pause between batches
      if (batchIndex + 1 < totalBatches) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // ── Generate rankings ──────────────────────────────────────────────────
    updateProgress({ phase: "scoring" });
    // Inject recentInsiderBuy flag from insider_transactions before ranking
    try {
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const recentBuys = sqlite.prepare(
        "SELECT DISTINCT ticker FROM insider_transactions WHERE is_open_market_buy = 1 AND transaction_date >= ?"
      ).all(cutoff) as { ticker: string }[];
      const buySet = new Set(recentBuys.map((r: any) => r.ticker as string));
      for (const raw of allRawData) { if (buySet.has(raw.ticker)) raw.recentInsiderBuy = true; }
    } catch { /* table may not exist yet */ }
    const strictness = (await storage.getSetting("strictness")) || "balanced";

    // Fix #11B: apply stored fallbacks for missing fundamentals
    const allRawWithFallbacks: RawStockData[] = await Promise.all(
      allRawData.map(async (raw) => {
        if (!raw.price || raw.error) return raw; // don't bother if fetch failed
        const stored = await storage.getLatestSnapshot(raw.ticker).catch(() => null);
        return stored ? applyStoredFallbacks(raw, stored as any) : raw;
      })
    );

    // Fix #12: build universe metadata array for sector-aware ranking
    const universeMetadata = allRawWithFallbacks.map((raw) => {
      const meta = stockMeta[raw.ticker];
      return { sector: meta?.sector ?? null, assetType: meta?.assetType ?? null };
    });

    const rankings = rankMultiple(allRawWithFallbacks, strictness, universeMetadata);

    // ── Persist results ────────────────────────────────────────────────────
    updateProgress({ phase: "saving" });
    for (let i = 0; i < allRawWithFallbacks.length; i++) {
      const raw = allRawWithFallbacks[i];
      const ranking = rankings.find((r) => r.ticker === raw.ticker);
      if (!ranking) continue;

      const isSuccess = !raw.error && raw.price != null;

      try {
        const snapshotId = await storage.saveSnapshot(raw);
        await storage.saveRecommendation(ranking, snapshotId);

        if (isSuccess) {
          // ── Backfill company name from Yahoo meta if current name looks like bare ticker ──
          const meta = stockMeta[raw.ticker];
          const currentName = meta?.name ?? raw.ticker;
          const isNumericOrBare = /^[\d\s.]+$/.test(currentName) || currentName === raw.ticker;
          const newName = raw.longName || raw.shortName || (raw as any).displayName || raw.quoteType;
          if ((isNumericOrBare || currentName === raw.ticker) && newName && newName !== raw.ticker) {
            await storage.updateUniverseName(raw.ticker, newName);
            // Also update our local lookup so opportunity score gets the real name
            if (stockMeta[raw.ticker]) stockMeta[raw.ticker].name = newName;
          }

          // ── Reclassify sector using canonical list (3-layer) ─────────
          const currentSector = meta?.sector ?? null;
          const currentIndustry = meta?.industry ?? null;
          const companyName = raw.longName || raw.shortName || stockMeta[raw.ticker]?.name || null;
          const canonicalSector = classifySector(currentSector, currentIndustry, raw.ticker, companyName);
          if (canonicalSector && canonicalSector !== currentSector) {
            await storage.updateUniverseSector(raw.ticker, canonicalSector);
            if (stockMeta[raw.ticker]) stockMeta[raw.ticker].sector = canonicalSector;
          }

          // ── Compute Opportunity Score ──────────────────────────────────
          const oppScore = computeOpportunityScore(
            raw,
            stockMeta[raw.ticker]?.name ?? raw.ticker,
            meta?.sector ?? null,
            meta?.industry ?? null
          );
          await storage.saveOpportunityScore(oppScore, snapshotId);

          // Reset consecutive-fail counter on success
          await storage.resetConsecutiveFails(raw.ticker);
          succeeded++;
        } else {
          // ── Track failure with category ────────────────────────────────
          const category = categoriseError(raw);
          await storage.recordFailedStock(raw.ticker, raw.error ?? "unknown error", category);

          // Auto-deactivate permanently dead tickers:
          //   not_found  >= 2 consecutive fails → deactivate (404 = delisted/invalid)
          //   unknown    >= 3 consecutive fails → deactivate (persistent unknown error)
          const failCount = await storage.getConsecutiveFails(raw.ticker);
          const deactivateThreshold = category === "not_found" ? 2 : 3;
          if (failCount >= deactivateThreshold && (category === "not_found" || category === "unknown")) {
            console.log(`[Scheduler] Deactivating ${raw.ticker} after ${failCount}x ${category} — removing from active universe`);
            await storage.removeFromUniverse(raw.ticker);
            await storage.flagAutoRemoved(raw.ticker, `${category} x${failCount}`);
          }
          failed++;
        }
      } catch (err) {
        console.error(`[Scheduler] Error saving ${raw.ticker}:`, err);
        failed++;
      }

      updateProgress({ succeeded, failed });
    }

    const completedAt = new Date().toISOString();
    await storage.logRefresh({
      startedAt,
      completedAt,
      tickersAttempted: attempted,
      tickersSucceeded: succeeded,
      tickersFailed: failed,
      triggerType,
      intervalMinutes: currentInterval,
    });

    // Refresh summary — counts permanent deactivations for visibility in Railway logs
    const deactivatedCount = (await storage.getFailedStocks())
      .filter((f) => f.autoRemoved).length;
    console.log(
      `[Scheduler] Done. Attempted: ${attempted}, Succeeded: ${succeeded}, Failed: ${failed}` +
      (deactivatedCount > 0 ? `, Permanently deactivated: ${deactivatedCount}` : "")
    );
  } catch (err) {
    console.error("[Scheduler] Refresh error:", err);
  } finally {
    updateProgress({
      isRefreshing: false,
      phase: "done",
      estimatedSecondsRemaining: null,
    });
  }

  return { attempted, succeeded, failed };
}

// ─── Insider Bulk Refresh ─────────────────────────────────────────────────────
let insiderRefreshRunning = false;

export async function runInsiderBulkRefresh(): Promise<{ attempted: number; succeeded: number; failed: number }> {
  if (insiderRefreshRunning) {
    console.log("[InsiderRefresh] Already running, skipping");
    return { attempted: 0, succeeded: 0, failed: 0 };
  }
  insiderRefreshRunning = true;
  let attempted = 0, succeeded = 0, failed = 0;
  try {
    const tickers: { ticker: string }[] = sqlite.prepare("SELECT ticker FROM universe WHERE is_active = 1").all() as { ticker: string }[];
    console.log(`[InsiderRefresh] Starting bulk refresh for ${tickers.length} tickers`);

    const axios2 = (await import("axios")).default;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    // Get crumb once for entire batch
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
          const raw2 = typeof crumbResp.data === "string" ? crumbResp.data.trim() : null;
          if (raw2 && !raw2.startsWith("{") && !raw2.includes(" ") && raw2.length <= 50) { crumb = raw2; break; }
        }
      }
    } catch { /* crumb unavailable */ }

    const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
    const insertStmt = sqlite.prepare(`
      INSERT OR REPLACE INTO insider_transactions
        (ticker, filed_at, transaction_date, insider_name, relation, transaction_type, shares, value, fetched_at, is_open_market_buy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const { ticker } of tickers) {
      attempted++;
      try {
        const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=insiderTransactions${crumbParam}`;
        const resp = await axios2.get(url, {
          headers: { "User-Agent": UA, "Cookie": cookieStr },
          timeout: 10000, validateStatus: () => true,
        });
        if (resp.status !== 200) { failed++; continue; }
        const txns = resp.data?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions ?? [];
        if (!Array.isArray(txns) || txns.length === 0) { succeeded++; continue; }
        const fetchedAt = new Date().toISOString();
        // Delete old rows for this ticker, insert up to 5 most recent
        sqlite.prepare("DELETE FROM insider_transactions WHERE ticker = ?").run(ticker);
        for (const t of txns.slice(0, 5)) {
          const desc: string = (t.transactionDescription ?? "").toLowerCase();
          const sharesRaw: number | null = t.shares?.raw ?? null;
          const valueRaw: number | null = t.value?.raw ?? null;

          // Classify transaction type:
          // 1. Use transactionDescription if available ("Purchase", "Sale", etc.)
          // 2. If null, synthesize from ownership + sign of shares/value
          //    Yahoo returns ownership="D" (Direct) or "I" (Indirect) but no longer reliably
          //    returns transactionDescription. We treat positive-value, positive-share txns
          //    as purchases (most insider filings are either purchases or sales at market price).
          let transactionType: string | null = t.transactionDescription ?? null;
          if (!transactionType) {
            // Fallback: positive shares+value = Purchase, negative = Sale
            if (sharesRaw != null && sharesRaw > 0 && valueRaw != null && valueRaw > 0) {
              transactionType = "Purchase";
            } else if (sharesRaw != null && sharesRaw < 0) {
              transactionType = "Sale";
            }
            // else leave null (e.g. option grants with 0 value)
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
            isOpenMarketBuy,
          );
        }
        succeeded++;
      } catch { failed++; }
      // ~1 req/sec to avoid rate limits
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`[InsiderRefresh] Done. Attempted: ${attempted}, Succeeded: ${succeeded}, Failed: ${failed}`);
  } finally {
    insiderRefreshRunning = false;
  }
  return { attempted, succeeded, failed };
}

export function startScheduler(intervalMinutes: RefreshInterval = 15): void {
  stopScheduler();
  currentInterval = intervalMinutes;

  const cronExpr =
    intervalMinutes === 5  ? "*/5 * * * *"  :
    intervalMinutes === 15 ? "*/15 * * * *" :
    intervalMinutes === 30 ? "*/30 * * * *" :
    "0 * * * *";

  scheduledTask = cron.schedule(cronExpr, async () => {
    if (anyMarketOpen()) {
      console.log(`[Scheduler] Scheduled refresh triggered (${intervalMinutes}min)`);
      await runRefresh("scheduled");
    } else {
      console.log("[Scheduler] No markets open, skipping scheduled refresh");
    }
  });

  // Twice-weekly insider bulk refresh: Mon + Thu at 06:00 UTC
  cron.schedule("0 6 * * 1,4", async () => {
    console.log("[InsiderRefresh] Twice-weekly cron triggered");
    await runInsiderBulkRefresh();
  });

  console.log(`[Scheduler] Started with ${intervalMinutes}min interval`);
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

export function getSchedulerState(): {
  running: boolean;
  intervalMinutes: RefreshInterval;
  isRefreshing: boolean;
  anyMarketOpen: boolean;
} {
  return {
    running: scheduledTask !== null,
    intervalMinutes: currentInterval,
    isRefreshing: _progress.isRefreshing,
    anyMarketOpen: anyMarketOpen(),
  };
}
