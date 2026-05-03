import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ChevronUp, ChevronDown, Filter, Search, Globe, AlertTriangle,
  CheckCircle, Clock, Info, Sliders, Trophy, Activity, ChevronRight
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import SignalBadge from "@/components/SignalBadge";
import ScoreBar from "@/components/ScoreBar";
import DataTag from "@/components/DataTag";
import { apiRequest, getAuthToken } from "@/lib/queryClient";
import { Wifi, WifiOff } from "lucide-react";
import { useCurrency, formatPrice } from "@/lib/currencyContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveRec {
  ticker: string; stockName: string; exchange: string; country: string; region: string;
  currency: string; sector: string | null; assetType: string;
  signal20d: string; signal60d: string; signal120d: string; signal250d: string;
  confidence20d: number; confidence60d: number; confidence120d: number; confidence250d: number;
  factorMomentum: number; factorTrend: number; factorEarnings: number;
  factorValuation: number; factorQuality: number; factorSentiment: number;
  compositeScore: number; riskFlags: string; explanation: string;
  price: number; changePct: number; volume: number; rsi14: number;
  nativeCurrency?: string | null;
  priceEur?: number | null;
  priceUsd?: number | null;
  dataFreshness: string; fetchedAt: string; generatedAt: string;
  // Fix #11A: coverage
  dataCoverage?: number | null;
  coverageTier?: string | null;
  sectorGroup?: string | null;
  // Live-computed fields
  liveRank: number; livePercentile: number; liveHorizonScore: number;
  liveSignal: string; liveHorizon: string; liveStrictness: string;
  liveConfidence?: number; liveExplanation?: string;
  horizonWeights?: { momentum: number; trend: number; earnings: number; valuation: number; quality: number; sentiment: number; label: string; targetDescription: string; };
}

interface ApiResponse {
  data: LiveRec[];
  count: number;
  totalInUniverse: number;
  strictness: string;
  horizon: string;
  thresholds: { buyTopPct: number; watchPct: number; buyCount: number; watchCount: number; avoidCount: number; };
  horizonProfile?: { label: string; targetDescription: string; weights: Record<string, number>; };
  scoreSpread?: { min: number; max: number; top3: Array<{ ticker: string; score: number }> };
  computedAt: string;
  cacheNote: string;
  recomputeEvidence?: string;
  durationMs?: number;
  warning?: string;
  timestamp: string;
  error?: string;
  detail?: string;
}

type SortField = "liveRank" | "liveHorizonScore" | "compositeScore" | "changePct" | "ticker" | "rsi14";
type SortDir = "asc" | "desc";
type Strictness = "conservative" | "balanced" | "opportunistic";
type Horizon = "20" | "60" | "120" | "250";
type TopKMode = "all" | "10" | "20" | "50";

// ─── Constants ────────────────────────────────────────────────────────────────

const REGIONS = ["Americas", "Europe", "Asia", "Global"];
const EXCHANGES = ["NASDAQ", "NYSE", "XETRA", "LSE", "EURONEXT", "SIX", "OMX", "BME", "OTC"];
const SECTORS = [
  "Technology",
  "Financials",
  "Healthcare",
  "Defense & Aerospace",
  "Industrials",
  "Energy – Oil & Gas",
  "Clean Energy",
  "Nuclear",
  "Automotive",
  "Retail & Leisure",
  "Consumer Staples",
  "Communication Services",
  "Materials",
  "Real Estate",
  "Utilities",
  "Crypto & Digital Assets",
];

const STRICTNESS_LABELS: Record<Strictness, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  opportunistic: "Opportunistic",
};
const STRICTNESS_DESCRIPTIONS: Record<Strictness, string> = {
  conservative: "Top 10% → Buy · Next 20% → Watch",
  balanced: "Top 15% → Buy · Next 25% → Watch",
  opportunistic: "Top 25% → Buy · Next 30% → Watch",
};
const HORIZON_DESCRIPTIONS: Record<Horizon, string> = {
  "20":  "20d — Momentum 35% · Trend 25% · Earnings 20% · Valuation 8% · Quality 7%: Near-term catalyst & price persistence. High volatility penalty.",
  "60":  "60d — Earnings 25% · Momentum 25% · Trend 20% · Valuation 14% · Quality 11%: Balanced mix of earnings direction and momentum.",
  "120": "120d — Earnings 24% · Valuation 22% · Quality 20% · Trend 14% · Momentum 15%: Quality and valuation increasingly predictive.",
  "250": "250d — Valuation 30% · Quality 25% · Earnings 22% · Trend 10% · Momentum 8%: Long-horizon fundamental thesis. Minimal weight on short-term noise.",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(dec);
}
function fmtPrice(n: number | null | undefined, currency?: string): string {
  if (n === null || n === undefined) return "—";
  const sym = currency === "EUR" ? "€" : currency === "GBp" ? "p" : currency === "CHF" ? "Fr" : currency === "DKK" ? "kr" : "$";
  if (currency === "GBp") return `${sym}${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return sym + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtVol(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}
function relativeTime(iso: string): string {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Fix #11A: data coverage badge
function CoverageBadge({ coverage, tier }: { coverage?: number | null; tier?: string | null }) {
  if (coverage == null) return <span className="text-muted-foreground text-xs">—</span>;
  const label = tier === "high" ? "H" : tier === "medium" ? "M" : "L";
  const color =
    tier === "high"   ? "text-green-600 bg-green-500/10 border-green-500/30" :
    tier === "medium" ? "text-yellow-600 bg-yellow-500/10 border-yellow-500/30" :
                        "text-red-500 bg-red-500/10 border-red-500/30";
  return (
    <Tooltip>
      <TooltipTrigger>
        <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${color}`}>
          {Math.round(coverage)}%
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">Data coverage: <strong>{Math.round(coverage)}%</strong> ({label === "H" ? "High" : label === "M" ? "Medium" : "Low"})</p>
        {tier === "low" && <p className="text-xs text-amber-400 mt-1">⚠ Low coverage — Buy label suppressed</p>}
        {tier === "medium" && <p className="text-xs text-yellow-400 mt-1">Moderate coverage — sector gate required for Buy</p>}
      </TooltipContent>
    </Tooltip>
  );
}

function RiskFlagsCell({ flags }: { flags: string }) {
  let parsed: string[] = [];
  try { parsed = JSON.parse(flags) || []; } catch { parsed = []; }
  if (!parsed.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger>
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <ul className="space-y-1">
          {parsed.map((f, i) => <li key={i} className="text-xs">• {f}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function RankBadge({ rank, signal }: { rank?: number; signal?: string }) {
  if (!rank) return <span className="text-muted-foreground text-xs">—</span>;
  const color = signal === "buy"
    ? "text-green-500 bg-green-500/10 border-green-500/30"
    : signal === "avoid"
    ? "text-red-500 bg-red-500/10 border-red-500/30"
    : "text-yellow-500 bg-yellow-500/10 border-yellow-500/30";
  return (
    <span className={cn("inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums border", color)}>
      #{rank}
    </span>
  );
}

// ─── Diagnostics Panel ───────────────────────────────────────────────────────
// ─── Failed Stocks Section (inside Diagnostics) ─────────────────────────────

interface FailedStockEntry {
  ticker: string;
  lastError: string;
  errorCategory: string;
  consecutiveFails: number;
  lastFailedAt: string;
  autoRemoved: boolean;
}

function FailedStocksSection() {
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<{ succeeded: number; failed: number } | null>(null);

  const { data, isLoading, refetch } = useQuery<{ count: number; byCategory: Record<string, number>; stocks: FailedStockEntry[]; autoRemovedCount: number }>({
    queryKey: ["/api/diagnostics/failed-stocks"],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch("/api/diagnostics/failed-stocks", {
        headers: token ? { "Authorization": `Bearer ${token}` } : {},
      });
      return res.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  async function handleRetry() {
    setRetrying(true);
    setRetryResult(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/diagnostics/retry-failed", {
        method: "POST",
        headers: token ? { "Authorization": `Bearer ${token}` } : {},
      });
      const result = await res.json();
      setRetryResult({ succeeded: result.succeeded, failed: result.failed });
      refetch();
      qc.invalidateQueries({ queryKey: ["/api/recommendations"] });
    } finally {
      setRetrying(false);
    }
  }

  const categoryColors: Record<string, string> = {
    not_found: "text-red-400",
    rate_limited: "text-yellow-400",
    network_timeout: "text-orange-400",
    missing_price: "text-blue-400",
    unknown: "text-muted-foreground",
  };

  if (isLoading) return <div className="text-muted-foreground text-[11px]">Loading…</div>;
  const count = data?.count ?? 0;
  const autoRemovedCount = data?.autoRemovedCount ?? 0;

  return (
    <div className="col-span-2 mt-1">
      <div className="flex items-center justify-between mb-1.5">
        <div className="font-semibold text-muted-foreground text-[11px] flex items-center gap-2">
          Failed Stocks
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold",
            count === 0 ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-400")}>
            {count}
          </span>
          {autoRemovedCount > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-700/40 text-zinc-400">
              {autoRemovedCount} auto-removed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="text-[10px] px-2 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            Refresh
          </button>
          {count > 0 && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="text-[10px] px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
            >
              {retrying ? "Retrying…" : `Retry ${count} failed`}
            </button>
          )}
        </div>
      </div>

      {retryResult && (
        <div className="mb-1.5 text-[10px] rounded bg-green-500/10 border border-green-500/20 px-2 py-1 text-green-400">
          Retry complete: {retryResult.succeeded} recovered, {retryResult.failed} still failing
        </div>
      )}

      {count === 0 ? (
        <div className="text-[10px] text-green-500">No failed stocks — all fetched successfully.</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-1.5">
            {Object.entries(data?.byCategory ?? {}).map(([cat, n]) => (
              <span key={cat} className={cn("text-[10px] font-mono", categoryColors[cat] ?? "text-muted-foreground")}>
                {cat.replace(/_/g, " ")}: {n}
              </span>
            ))}
          </div>
          <div className="rounded border border-border overflow-auto max-h-36">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-2 py-1 text-muted-foreground font-medium">Ticker</th>
                  <th className="text-left px-2 py-1 text-muted-foreground font-medium">Category</th>
                  <th className="text-left px-2 py-1 text-muted-foreground font-medium"># Fails</th>
                  <th className="text-left px-2 py-1 text-muted-foreground font-medium">Last Error</th>
                </tr>
              </thead>
              <tbody>
                {(data?.stocks ?? []).slice(0, 50).map((s) => (
                  <tr key={s.ticker} className="border-b border-border/50 last:border-0">
                    <td className="px-2 py-1 font-mono text-foreground">{s.ticker}</td>
                    <td className={cn("px-2 py-1 font-mono", categoryColors[s.errorCategory] ?? "text-muted-foreground")}>
                      {s.errorCategory.replace(/_/g, " ")}
                    </td>
                    <td className={cn("px-2 py-1 font-mono",
                      s.consecutiveFails >= 3 ? "text-red-400" : "text-muted-foreground")}>
                      {s.consecutiveFails}{s.consecutiveFails >= 3 ? " ⚠" : ""}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground truncate max-w-[180px]" title={s.lastError}>
                      {s.lastError}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(data?.stocks?.length ?? 0) > 50 && (
            <div className="text-[10px] text-muted-foreground mt-1">Showing 50 of {data?.stocks.length}</div>
          )}
        </>
      )}
    </div>
  );
}


function DiagnosticsPanel({
  apiResponse, horizon, strictness, signalFilter, topKMode, region, exchange, sector, assetType,
  isLoading, isFreshFetch, backendStatus,
}: {
  apiResponse: ApiResponse | undefined;
  horizon: Horizon; strictness: Strictness; signalFilter: string; topKMode: TopKMode;
  region: string; exchange: string; sector: string; assetType: string;
  isLoading: boolean; isFreshFetch: boolean;
  backendStatus: "ok" | "error" | "checking";
}) {
  const [open, setOpen] = useState(false);

  const params: Record<string, string> = {
    horizon, strictness,
    ...(signalFilter !== "all" ? { signal: signalFilter } : {}),
    ...(topKMode !== "all" ? { topK: topKMode } : {}),
    ...(region !== "all" ? { region } : {}),
    ...(exchange !== "all" ? { exchange } : {}),
    ...(sector !== "all" ? { sector } : {}),
    ...(assetType !== "all" ? { assetType } : {}),
  };
  const queryString = new URLSearchParams(params).toString();

  const hw = apiResponse?.horizonProfile?.weights;

  return (
    <div className="rounded-lg border border-border bg-card/60 text-xs" data-testid="diagnostics-panel">
      <button
        className="w-full flex items-center justify-between p-2.5 hover:bg-secondary/50 transition-colors"
        onClick={() => setOpen(!open)}
        data-testid="button-diagnostics-toggle"
      >
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-muted-foreground font-medium">Diagnostics</span>
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold",
            isLoading ? "bg-blue-500/20 text-blue-400"
            : isFreshFetch ? "bg-green-500/20 text-green-500"
            : "bg-yellow-500/20 text-yellow-500")}>
            {isLoading ? "fetching…" : isFreshFetch ? "fresh" : "cached"}
          </span>
          {/* Backend health indicator */}
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1",
            backendStatus === "ok" ? "bg-green-500/10 text-green-500"
            : backendStatus === "error" ? "bg-red-500/10 text-red-500"
            : "bg-muted/20 text-muted-foreground")}>
            {backendStatus === "ok" ? <><Wifi className="w-2.5 h-2.5" /> server ok</>
             : backendStatus === "error" ? <><WifiOff className="w-2.5 h-2.5" /> server offline</>
             : "…"}
          </span>
        </div>
        <ChevronRight className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="border-t border-border p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-[11px]">

          {/* Column 1: Active state */}
          <div>
            <div className="font-semibold text-muted-foreground mb-1">Active State</div>
            <div className="space-y-0.5">
              <div><span className="text-muted-foreground">Horizon:</span> <span className="font-mono text-foreground">{horizon}d</span></div>
              <div><span className="text-muted-foreground">Strictness:</span> <span className="font-mono text-foreground">{strictness}</span></div>
              <div><span className="text-muted-foreground">Signal filter:</span> <span className="font-mono text-foreground">{signalFilter}</span></div>
              <div><span className="text-muted-foreground">Top-K:</span> <span className="font-mono text-foreground">{topKMode}</span></div>
              <div><span className="text-muted-foreground">Backend:</span> <span className={cn("font-mono", backendStatus === "ok" ? "text-green-500" : "text-red-500")}>{backendStatus}</span></div>
            </div>
          </div>

          {/* Column 2: API request */}
          <div>
            <div className="font-semibold text-muted-foreground mb-1">API Request</div>
            <div className="font-mono text-[10px] bg-secondary rounded p-1.5 break-all text-muted-foreground">
              GET /api/recommendations?{queryString}
            </div>
            {apiResponse?.durationMs !== undefined && (
              <div className="mt-1 text-muted-foreground">Response: <span className="font-mono text-foreground">{apiResponse.durationMs}ms</span></div>
            )}
          </div>

          {/* Column 3: Backend response */}
          <div>
            <div className="font-semibold text-muted-foreground mb-1">Backend Response</div>
            {apiResponse ? (
              <div className="space-y-0.5">
                <div><span className="text-muted-foreground">Total in universe:</span> <span className="font-mono">{apiResponse.totalInUniverse}</span></div>
                <div><span className="text-muted-foreground">Buy:</span> <span className="font-mono text-green-500">{apiResponse.thresholds?.buyCount}</span> (top {apiResponse.thresholds?.buyTopPct}%)</div>
                <div><span className="text-muted-foreground">Watch:</span> <span className="font-mono text-yellow-500">{apiResponse.thresholds?.watchCount}</span> ({apiResponse.thresholds?.watchPct}%)</div>
                <div><span className="text-muted-foreground">Avoid:</span> <span className="font-mono text-red-500">{apiResponse.thresholds?.avoidCount}</span></div>
                <div><span className="text-muted-foreground">Computed at:</span> <span className="font-mono">{apiResponse.computedAt ? relativeTime(apiResponse.computedAt) : "—"}</span></div>
                {apiResponse.scoreSpread && (
                  <div><span className="text-muted-foreground">Score range:</span> <span className="font-mono">{apiResponse.scoreSpread.min.toFixed(1)}–{apiResponse.scoreSpread.max.toFixed(1)}</span></div>
                )}
                {apiResponse.scoreSpread?.top3 && (
                  <div><span className="text-muted-foreground">Top 3:</span> {apiResponse.scoreSpread.top3.map(x => `${x.ticker}(${x.score.toFixed(1)})`).join(", ")}</div>
                )}
              </div>
            ) : <span className="text-muted-foreground italic">No response yet</span>}
          </div>

          {/* Column 4: Horizon weights — proves recompute is horizon-specific */}
          <div>
            <div className="font-semibold text-muted-foreground mb-1">
              {horizon}d Factor Weights
              <span className="ml-1 text-[9px] font-normal text-green-500">(from backend)</span>
            </div>
            {hw ? (
              <div className="space-y-0.5">
                {Object.entries(hw).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="text-muted-foreground w-16 capitalize">{k}:</span>
                    <div className="flex-1 bg-secondary rounded-full h-1.5 overflow-hidden">
                      <div className="h-full bg-primary rounded-full" style={{ width: `${Math.round(v * 100)}%` }} />
                    </div>
                    <span className="font-mono text-foreground w-8 text-right">{Math.round(v * 100)}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground leading-relaxed">{HORIZON_DESCRIPTIONS[horizon]}</div>
            )}
            <div className="mt-1.5 text-[10px] text-muted-foreground italic">{apiResponse?.recomputeEvidence}</div>
            <div className="mt-1 text-muted-foreground">
              <span className="font-medium">{STRICTNESS_LABELS[strictness]}:</span>{" "}
              {STRICTNESS_DESCRIPTIONS[strictness]}
            </div>
          </div>

          {/* Warning if no data */}
          {apiResponse?.warning === "NO_DATA" && (
            <div className="col-span-2 rounded bg-amber-500/10 border border-amber-500/30 p-2 text-amber-500">
              No stock data in database. Click <strong>Refresh</strong> in the header to fetch prices from Yahoo Finance.
            </div>
          )}

          {/* Failed stocks section */}
          <FailedStocksSection />

        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const qc = useQueryClient();
  const { displayCurrency } = useCurrency();

  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("all");
  const [exchange, setExchange] = useState("all");
  const [sector, setSector] = useState("all");
  const [assetType, setAssetType] = useState("all");
  const [signalFilter, setSignalFilter] = useState("all");
  const [horizon, setHorizon] = useState<Horizon>("60");
  const [strictness, setStrictness] = useState<Strictness>("balanced");
  const [topKMode, setTopKMode] = useState<TopKMode>("all");
  const [liquidityFilter, setLiquidityFilter] = useState<"off" | "moderate" | "strict">("moderate");
  const [sortField, setSortField] = useState<SortField>("liveRank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showFilters, setShowFilters] = useState(false);
  const [fetchCount, setFetchCount] = useState(0);

  // Health check — polls /api/health every 30s
  const { data: healthData, error: healthError } = useQuery({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });
  const backendStatus: "ok" | "error" | "checking" =
    healthData ? "ok" : healthError ? "error" : "checking";

  // Build query params — these are part of the queryKey so cache is per-combination
  const queryParams = useMemo(() => {
    const p: Record<string, string> = { horizon, strictness };
    if (signalFilter !== "all") p.signal = signalFilter;
    if (topKMode !== "all") p.topK = topKMode;
    if (region !== "all") p.region = region;
    if (exchange !== "all") p.exchange = exchange;
    if (sector !== "all") p.sector = sector;
    if (assetType !== "all") p.assetType = assetType;
    p.liquidityFilter = liquidityFilter;
    return p;
  }, [horizon, strictness, signalFilter, topKMode, region, exchange, sector, assetType, liquidityFilter]);

  const queryString = useMemo(() => new URLSearchParams(queryParams).toString(), [queryParams]);

  // CRITICAL FIX: queryKey includes horizon + strictness + all filter params
  // This means each unique combination gets its own cache entry AND triggers a fresh fetch
  const { data, isLoading, error, isFetching, dataUpdatedAt } = useQuery<ApiResponse>({
    queryKey: ["/api/recommendations", horizon, strictness, signalFilter, topKMode, region, exchange, sector, assetType, liquidityFilter],
    queryFn: async () => {
      setFetchCount(c => c + 1);
      const token = getAuthToken();
      const res = await fetch(`/api/recommendations?${queryString}`, {
        headers: token ? { "Authorization": `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        // Parse backend error detail if available
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.detail || j.error || detail; } catch {}
        throw new Error(detail);
      }
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const recs = data?.data ?? [];

  // Client-side search filter only (all other filters are server-side)
  const filtered = useMemo(() => {
    let result = [...recs];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((r) =>
        r.ticker.toLowerCase().includes(q) || r.stockName.toLowerCase().includes(q)
      );
    }
    // Sort
    result.sort((a, b) => {
      if (sortField === "ticker") {
        return sortDir === "asc" ? a.ticker.localeCompare(b.ticker) : b.ticker.localeCompare(a.ticker);
      }
      const va = (a[sortField] as number) ?? 0;
      const vb = (b[sortField] as number) ?? 0;
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return result;
  }, [recs, search, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortField(field); setSortDir(field === "liveRank" ? "asc" : "desc"); }
  }

  function SortHeader({ field, label }: { field: SortField; label: string }) {
    const active = sortField === field;
    return (
      <button
        onClick={() => toggleSort(field)}
        className={cn("flex items-center gap-0.5 hover:text-foreground transition-colors",
          active ? "text-primary" : "text-muted-foreground")}
      >
        {label}
        {active ? (sortDir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />) : null}
      </button>
    );
  }

  // KPI counts from live signals
  const counts = useMemo(() => ({
    buy: recs.filter((r) => r.liveSignal === "buy").length,
    watch: recs.filter((r) => r.liveSignal === "watch").length,
    avoid: recs.filter((r) => r.liveSignal === "avoid").length,
  }), [recs]);

  const isFreshFetch = dataUpdatedAt > Date.now() - 5000;

  return (
    <TooltipProvider>
      <div className="p-4 space-y-4" data-testid="page-dashboard">

        {/* KPI Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="bg-card border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1">Universe</div>
              <div className="text-xl font-semibold tabular-nums text-foreground">
                {isLoading ? <Skeleton className="h-6 w-12" /> : data?.totalInUniverse ?? 0}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {horizon}d · {STRICTNESS_LABELS[strictness]}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <CheckCircle className="w-3 h-3 text-green-500" /> Buy
              </div>
              <div className="text-xl font-semibold tabular-nums text-green-500">
                {isLoading ? <Skeleton className="h-6 w-8" /> : counts.buy}
              </div>
              <div className="text-[10px] text-muted-foreground">
                top {data?.thresholds?.buyTopPct ?? "—"}% of universe
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <Clock className="w-3 h-3 text-yellow-500" /> Watch
              </div>
              <div className="text-xl font-semibold tabular-nums text-yellow-500">
                {isLoading ? <Skeleton className="h-6 w-8" /> : counts.watch}
              </div>
              <div className="text-[10px] text-muted-foreground">next {data?.thresholds?.watchPct ?? "—"}%</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 text-red-500" /> Avoid
              </div>
              <div className="text-xl font-semibold tabular-nums text-red-500">
                {isLoading ? <Skeleton className="h-6 w-8" /> : counts.avoid}
              </div>
              <div className="text-[10px] text-muted-foreground">bottom percentile</div>
            </CardContent>
          </Card>
        </div>

        {/* Controls row 1 */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search ticker or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
                data-testid="input-search"
              />
            </div>

            {/* Horizon selector — CRITICAL: changes queryKey → forces fresh fetch */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground hidden sm:inline">Horizon:</span>
              <div className="flex items-center bg-secondary rounded-md overflow-hidden border border-border">
                {(["20", "60", "120", "250"] as Horizon[]).map((h) => (
                  <Tooltip key={h}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setHorizon(h)}
                        className={cn(
                          "px-2.5 py-1.5 text-xs font-medium transition-colors",
                          horizon === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                        data-testid={`button-horizon-${h}`}
                      >
                        {h}d
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px]">
                      <p className="text-xs">{HORIZON_DESCRIPTIONS[h]}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* Signal filter */}
            <Select value={signalFilter} onValueChange={setSignalFilter}>
              <SelectTrigger className="h-8 w-28 text-xs" data-testid="select-signal">
                <SelectValue placeholder="Signal" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All signals</SelectItem>
                <SelectItem value="buy">Buy</SelectItem>
                <SelectItem value="watch">Watch</SelectItem>
                <SelectItem value="avoid">Avoid</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline" size="sm" className="h-8 gap-1 text-xs"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="w-3.5 h-3.5" />
              Filters
              {(region !== "all" || exchange !== "all" || sector !== "all" || assetType !== "all") && (
                <Badge className="ml-0.5 h-4 w-4 p-0 text-[9px] flex items-center justify-center">
                  {[region, exchange, sector, assetType].filter((v) => v !== "all").length}
                </Badge>
              )}
            </Button>
          </div>

          {/* Controls row 2: Strictness + Top-K */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Strictness:</span>
              <div className="flex items-center bg-secondary rounded-md overflow-hidden border border-border">
                {(["conservative", "balanced", "opportunistic"] as Strictness[]).map((s) => (
                  <Tooltip key={s}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setStrictness(s)}
                        className={cn(
                          "px-2.5 py-1.5 text-xs font-medium transition-colors",
                          strictness === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                        data-testid={`button-strictness-${s}`}
                      >
                        {STRICTNESS_LABELS[s]}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent><p className="text-xs">{STRICTNESS_DESCRIPTIONS[s]}</p></TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <Trophy className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Show:</span>
              <div className="flex items-center bg-secondary rounded-md overflow-hidden border border-border">
                {(["all", "10", "20", "50"] as TopKMode[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setTopKMode(k)}
                    className={cn(
                      "px-2.5 py-1.5 text-xs font-medium transition-colors",
                      topKMode === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                    data-testid={`button-topk-${k}`}
                  >
                    {k === "all" ? "All" : `Top ${k}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Fetch indicator */}
            {isFetching && (
              <span className="text-[11px] text-muted-foreground animate-pulse">Recomputing…</span>
            )}
          </div>

          {/* Quick region filter buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            {["all", "Americas", "Europe", "Asia-Pacific"].map((r) => (
              <button
                key={r}
                onClick={() => setRegion(r)}
                data-testid={`filter-region-${r.toLowerCase()}`}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  region === r
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
                )}
              >
                {r === "all" ? "All" : r}
              </button>
            ))}
          </div>

          {/* Liquidity filter buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Sliders className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-xs text-muted-foreground">Liquidity:</span>
            {(["off", "moderate", "strict"] as const).map((lf) => (
              <button
                key={lf}
                onClick={() => setLiquidityFilter(lf)}
                data-testid={`filter-liquidity-${lf}`}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors capitalize",
                  liquidityFilter === lf
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
                )}
              >
                {lf === "off" ? "All" : lf.charAt(0).toUpperCase() + lf.slice(1)}
              </button>
            ))}
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              {liquidityFilter === "moderate" ? "(Cap ≥2B, Vol ≥500K, no OTC)" :
               liquidityFilter === "strict" ? "(Cap ≥10B, Vol ≥1M, no OTC)" :
               "(All stocks)"}
            </span>
          </div>

          {/* Expanded filters */}
          {showFilters && (
            <div className="flex flex-wrap gap-2 p-3 bg-card rounded-lg border border-border">
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="Region" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All regions</SelectItem>
                  {REGIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={exchange} onValueChange={setExchange}>
                <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="Exchange" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All exchanges</SelectItem>
                  {EXCHANGES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={sector} onValueChange={setSector}>
                <SelectTrigger className="h-7 w-40 text-xs"><SelectValue placeholder="Sector" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sectors</SelectItem>
                  {SECTORS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={assetType} onValueChange={setAssetType}>
                <SelectTrigger className="h-7 w-28 text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="stock">Stock</SelectItem>
                  <SelectItem value="etf">ETF</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground"
                onClick={() => { setRegion("all"); setExchange("all"); setSector("all"); setAssetType("all"); }}>
                Clear
              </Button>
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span data-testid="text-result-count">
            {isLoading ? "Loading…" : `${filtered.length} shown · ${data?.totalInUniverse ?? 0} in universe · ${horizon}d · ${STRICTNESS_LABELS[strictness]}`}
            {topKMode !== "all" && ` · Top ${topKMode} view`}
          </span>
          <Tooltip>
            <TooltipTrigger className="flex items-center gap-1">
              <Info className="w-3 h-3" />
              <span>Methodology</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="text-xs font-medium mb-1">Live percentile-based bucketing</p>
              <p className="text-xs text-muted-foreground">
                Labels are computed fresh on each request by: (1) adjusting scores for the selected horizon,
                (2) ranking all stocks by that adjusted score, (3) assigning labels by percentile bucket.
                Changing horizon or strictness triggers a new server-side computation.
              </p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Diagnostics panel */}
        <DiagnosticsPanel
          apiResponse={data}
          horizon={horizon} strictness={strictness}
          signalFilter={signalFilter} topKMode={topKMode}
          region={region} exchange={exchange} sector={sector} assetType={assetType}
          isLoading={isFetching} isFreshFetch={isFreshFetch}
          backendStatus={backendStatus}
        />

        {/* Main table */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[980px]">
              <thead className="sticky-thead">
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-center px-2 py-2 font-medium w-14">
                    <SortHeader field="liveRank" label="RANK" />
                  </th>
                  <th className="text-left px-3 py-2 font-medium w-44">
                    <SortHeader field="ticker" label="STOCK" />
                  </th>
                  <th className="text-center px-2 py-2 font-medium w-20">SIGNAL</th>
                  <th className="text-left px-2 py-2 font-medium w-28">
                    <Tooltip>
                      <TooltipTrigger>
                        <SortHeader field="liveHorizonScore" label={`SCORE ${horizon}d`} />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">Horizon-adjusted score for {horizon}-day view. Determines ranking order.</p>
                      </TooltipContent>
                    </Tooltip>
                  </th>
                  <th className="text-left px-2 py-2 font-medium w-24">
                    <Tooltip>
                      <TooltipTrigger>
                        <SortHeader field="compositeScore" label="RAW SCORE" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">Base composite score (horizon-independent). Same across all horizons.</p>
                      </TooltipContent>
                    </Tooltip>
                  </th>
                  <th className="text-right px-2 py-2 font-medium w-20">1D CHG</th>
                  <th className="text-right px-2 py-2 font-medium w-28">PRICE</th>
                  <th className="text-center px-2 py-2 font-medium w-14">
                    <SortHeader field="rsi14" label="RSI" />
                  </th>
                  <th className="text-right px-2 py-2 font-medium w-20">VOL</th>
                  <th className="text-left px-2 py-2 font-medium w-28">20d/60d/120d</th>
                  <th className="text-center px-2 py-2 font-medium w-8">⚑</th>
                  <th className="text-center px-2 py-2 font-medium w-16">COV</th>
                  <th className="text-left px-2 py-2 font-medium w-16">DATA</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {Array.from({ length: 12 }).map((_, j) => (
                      <td key={j} className="px-3 py-2.5"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))}

                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-muted-foreground">
                      <Globe className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <div className="text-sm">No data — click Refresh in the header to fetch stock data</div>
                    </td>
                  </tr>
                )}

                {!isLoading && filtered.map((r) => {
                  const flags = (() => { try { return JSON.parse(r.riskFlags) as string[]; } catch { return []; } })();

                  return (
                    <tr
                      key={r.ticker}
                      className="border-b border-border hover:bg-secondary/50 transition-colors"
                      data-testid={`row-stock-${r.ticker}`}
                    >
                      {/* Rank */}
                      <td className="px-2 py-2.5 text-center">
                        <RankBadge rank={r.liveRank} signal={r.liveSignal} />
                      </td>

                      {/* Stock */}
                      <td className="px-3 py-2.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link href={`/stock/${r.ticker}`}>
                              <a className="group block">
                                <div className="font-bold text-foreground group-hover:text-primary transition-colors text-sm leading-tight">
                                  {/^[\d\s.]+$/.test(r.stockName) ? `Unknown – ${r.ticker}` : (r.stockName || r.ticker)}
                                </div>
                                <div className="text-[11px] text-muted-foreground mt-0.5">
                                  {r.ticker}
                                  {r.exchange && (
                                    <span className="ml-1 opacity-70">· {r.exchange}</span>
                                  )}
                                </div>
                              </a>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            <p className="font-medium">{/^[\d\s.]+$/.test(r.stockName) ? `Unknown – ${r.ticker}` : (r.stockName || r.ticker)}</p>
                            <p className="text-muted-foreground">{r.ticker} · {r.exchange ?? "—"}</p>
                            {r.sector && <p className="text-muted-foreground">{r.sector}</p>}
                          </TooltipContent>
                        </Tooltip>
                      </td>

                      {/* Live signal for current horizon */}
                      <td className="px-2 py-2.5 text-center">
                        <Tooltip>
                          <TooltipTrigger>
                            <SignalBadge signal={r.liveSignal} size="sm" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[300px] text-xs">
                            <p className="font-medium mb-1">{r.stockName} — {horizon}d ({STRICTNESS_LABELS[strictness]})</p>
                            <p>Rank #{r.liveRank} · {horizon}d score: {r.liveHorizonScore?.toFixed(1)} · Confidence: {r.liveConfidence?.toFixed(0) ?? "—"}% · P{r.livePercentile?.toFixed(0)}</p>
                            <p className="text-muted-foreground mt-1">{r.liveExplanation ?? r.explanation}</p>
                          </TooltipContent>
                        </Tooltip>
                      </td>

                      {/* Horizon-adjusted score */}
                      <td className="px-2 py-2.5">
                        <ScoreBar score={r.liveHorizonScore} showValue size="xs" />
                      </td>

                      {/* Raw composite score */}
                      <td className="px-2 py-2.5">
                        <span className="tabular-nums text-xs text-muted-foreground">{r.compositeScore?.toFixed(1) ?? "—"}</span>
                      </td>

                      {/* 1d change */}
                      <td className="px-2 py-2.5 text-right">
                        {r.changePct !== null && r.changePct !== undefined ? (
                          <span className={cn("tabular-nums text-xs font-medium", r.changePct >= 0 ? "text-positive" : "text-negative")}>
                            {r.changePct >= 0 ? "+" : ""}{fmt(r.changePct)}%
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>

                      {/* Price */}
                      <td className="px-2 py-2.5 text-right">
                        <div className="flex flex-col items-end">
                          <span className="tabular-nums text-xs text-foreground">
                            {formatPrice(r.priceEur, r.priceUsd, r.price, r.nativeCurrency ?? r.currency, displayCurrency, false)}
                          </span>
                          {(r.priceEur != null || r.priceUsd != null) && (
                            <span className="tabular-nums text-[10px] text-muted-foreground">
                              {displayCurrency === "EUR" && r.priceUsd != null ? `(~$${r.priceUsd.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})})`
                                : displayCurrency === "USD" && r.priceEur != null ? `(~€${r.priceEur.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})})`
                                : ""}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* RSI */}
                      <td className="px-2 py-2.5 text-center">
                        {r.rsi14 ? (
                          <span className={cn("tabular-nums text-xs",
                            r.rsi14 > 70 ? "text-red-500" : r.rsi14 < 30 ? "text-green-500" : "text-muted-foreground")}>
                            {fmt(r.rsi14, 0)}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>

                      {/* Volume */}
                      <td className="px-2 py-2.5 text-right">
                        <span className="tabular-nums text-xs text-muted-foreground">{fmtVol(r.volume)}</span>
                      </td>

                      {/* Multi-horizon live signals */}
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-1">
                          <SignalBadge signal={r.signal20d} />
                          <SignalBadge signal={r.signal60d} />
                          <SignalBadge signal={r.signal120d} />
                        </div>
                      </td>

                      {/* Risk flags */}
                      <td className="px-2 py-2.5 text-center">
                        {flags.length > 0 ? <RiskFlagsCell flags={r.riskFlags} /> : null}
                      </td>

                      {/* Coverage badge - Fix #11A */}
                      <td className="px-2 py-2.5 text-center">
                        <CoverageBadge coverage={r.dataCoverage} tier={r.coverageTier} />
                      </td>

                      {/* Data freshness */}
                      <td className="px-2 py-2.5">
                        <DataTag freshness={r.dataFreshness} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 space-y-1">
            <div className="text-sm font-semibold text-destructive flex items-center gap-2">
              <WifiOff className="w-4 h-4" />
              Recommendations failed to load
            </div>
            <div className="text-xs text-destructive/80 font-mono">{(error as Error).message}</div>
            {backendStatus === "error" && (
              <div className="text-xs text-muted-foreground mt-1">
                The backend server appears to be offline. This app requires the Express server running on port 5000.
                Run: <code className="bg-secondary px-1 rounded">npm run start</code> in the project directory.
              </div>
            )}
            {backendStatus === "ok" && (
              <div className="text-xs text-muted-foreground mt-1">
                Server is reachable but the recommendations endpoint returned an error.
                Click <strong>Refresh</strong> to re-fetch stock data, or check the server logs.
              </div>
            )}
          </div>
        )}

        {/* Methodology footer */}
        <div className="text-[11px] text-muted-foreground/60 border-t border-border pt-3 space-y-0.5">
          <div>Labels computed server-side on every request using percentile ranking — not fixed thresholds. Horizon scores differ because each horizon weights factors differently (short=momentum/trend, long=quality/valuation).</div>
          <div>Sourced data only · Model outputs are probabilistic estimates · Not financial advice</div>
        </div>
      </div>
    </TooltipProvider>
  );
}
