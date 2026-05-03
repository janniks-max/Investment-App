import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import ScoreBar from "@/components/ScoreBar";
import SignalBadge from "@/components/SignalBadge";
import {
  TrendingUp, TrendingDown, Minus, ChevronRight, AlertCircle,
  BarChart2, Target, Clock, Zap, Shield, Layers, Search, SlidersHorizontal, X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FundamentalsRow {
  ticker: string;
  stockName: string;
  sector: string | null;
  industry: string | null;
  exchange: string;
  country: string;
  region: string;
  price: number | null;
  changePct: number | null;
  compositeScore: number;
  factorMomentum: number | null;
  factorTrend: number | null;
  factorEarnings: number | null;
  factorValuation: number | null;
  factorQuality: number | null;
  factorSentiment: number | null;
  factorVolatility: number | null;
  signal20d: string | null;
  signal60d: string | null;
  signal120d: string | null;
  signal250d: string | null;
  confidence20d: number | null;
  confidence60d: number | null;
  confidence120d: number | null;
  confidence250d: number | null;
  // Stored in pct-points (e.g. 12.5 = 12.5%) by dataFetcher * 100
  revenueGrowthYoy: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  roe: number | null;
  epsGrowthYoy: number | null;
  // Raw ratio
  pegRatio: number | null;
  debtEquity: number | null;
  pe: number | null;
  // fcfYield is computed as freeCashFlow/marketCap — fraction
  fcfYield: number | null;
  freeCashFlow: number | null;
  marketCap: number | null;
  analystBuy: number | null;
  analystHold: number | null;
  analystSell: number | null;
}

interface SectorPeers {
  sector: string;
  stockCount: number;
  avgRevenueGrowth: number | null;  // pct-points
  avgGrossMargin: number | null;    // pct-points
  avgOperatingMargin: number | null;
  avgRoe: number | null;
  avgDebtEquity: number | null;
  avgBuyRatio: number | null;
  avgHoldRatio: number | null;
  avgSellRatio: number | null;
  avgFcf: number | null;
  avgCompositeScore: number | null;
  avgPeg: number | null;
  avgFcfYield: number | null;
  capitalCycleStage: string;
  analysisTrend: string;
}

// Toggle: 1=Very Negative … 3=Neutral (zero impact) … 5=Very Positive
type ToggleLevel = 1 | 2 | 3 | 4 | 5;
interface ToggleState {
  tamOutlook: ToggleLevel;
  regulatoryEnv: ToggleLevel;
  disruptionRisk: ToggleLevel;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOGGLE_LABELS: Record<ToggleLevel, string> = {
  1: "Very Negative",
  2: "Negative",
  3: "Neutral",
  4: "Positive",
  5: "Very Positive",
};

// Neutral (3) = 0 score delta; symmetric ±
const TOGGLE_DELTA: Record<ToggleLevel, number> = {
  1: -20, 2: -10, 3: 0, 4: +10, 5: +20,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveBadge(score: number): { label: string; cls: string } {
  if (score >= 75) return { label: "Strong Buy",  cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" };
  if (score >= 60) return { label: "Buy",          cls: "bg-green-500/20 text-green-400 border-green-500/30" };
  if (score >= 40) return { label: "Hold",         cls: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" };
  if (score >= 25) return { label: "Sell",         cls: "bg-orange-500/20 text-orange-400 border-orange-500/30" };
  return                   { label: "Strong Sell",  cls: "bg-red-500/20 text-red-400 border-red-500/30" };
}

/** Value already in pct-points (e.g. 12.5 → "12.5%") */
function fmtPP(v: number | null, d = 1): string {
  if (v == null) return "—";
  return `${v.toFixed(d)}%`;
}

/** Raw fraction → percent (e.g. 0.032 → "3.2%") */
function fmtFrac(v: number | null, d = 1): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(d)}%`;
}

function fmtNum(v: number | null, d = 2): string {
  if (v == null) return "—";
  return v.toFixed(d);
}

function fmtMCap(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`;
  return `$${(v / 1e6).toFixed(0)}M`;
}

/** Color for pct-point values */
function ppColor(v: number | null, good: number, bad: number, higher = true): string {
  if (v == null) return "text-muted-foreground";
  return higher
    ? v >= good ? "text-green-400" : v <= bad ? "text-red-400" : "text-yellow-400"
    : v <= good ? "text-green-400" : v >= bad  ? "text-red-400" : "text-yellow-400";
}

function scoreToRec(score: number): { label: string; cls: string } {
  if (score >= 75) return { label: "Strong Buy",  cls: "text-emerald-400" };
  if (score >= 60) return { label: "Buy",          cls: "text-green-400" };
  if (score >= 40) return { label: "Hold",         cls: "text-yellow-400" };
  if (score >= 25) return { label: "Sell",         cls: "text-orange-400" };
  return                   { label: "Strong Sell",  cls: "text-red-400" };
}

function toSignalKey(sig: string | null): "buy" | "avoid" | "watch" | null {
  if (!sig) return null;
  const s = sig.toLowerCase();
  if (s.includes("buy"))  return "buy";
  if (s.includes("sell")) return "avoid";
  return "watch";
}

function buildRationale(
  s: FundamentalsRow,
  fund: number, struct: number, pos: number, mom: number,
  peers: SectorPeers | undefined,
): string {
  const drivers = [
    { label: "fundamentals",      score: fund },
    { label: "structural trends", score: struct },
    { label: "sector positioning",score: pos },
    { label: "momentum",          score: mom },
  ].sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  const top    = drivers[0];
  const bottom = drivers[drivers.length - 1];

  parts.push(top.score >= 65 ? `Strong ${top.label}` : top.score <= 35 ? "Weak across all factors" : `Moderate ${top.label}`);

  if (s.revenueGrowthYoy != null) {
    if (s.revenueGrowthYoy > 15)      parts.push(`revenue +${s.revenueGrowthYoy.toFixed(0)}% YoY`);
    else if (s.revenueGrowthYoy < 0)  parts.push(`revenue ${s.revenueGrowthYoy.toFixed(0)}% YoY`);
  }
  if (bottom.score < 40 && bottom.label !== top.label) parts.push(`weak ${bottom.label}`);

  if (peers && s.sector) {
    const avg = peers.avgCompositeScore ?? 50;
    if (s.compositeScore > avg + 10)      parts.push(`outperforms ${s.sector} peers`);
    else if (s.compositeScore < avg - 10) parts.push(`lags ${s.sector} peers`);
  }

  return parts.join("; ") + ".";
}

// ─── Inline SVG sparkline (stock vs sector avg — single-point comparison bar) ─

function ComparisonSparkline({
  stockVal, sectorAvg, label, good, bad, higher = true,
}: {
  stockVal: number | null;
  sectorAvg: number | null;
  label: string;
  good: number;
  bad: number;
  higher?: boolean;
}) {
  if (stockVal == null) {
    return <span className="text-[10px] text-muted-foreground/50">—</span>;
  }

  // Determine display range: center around sector avg or stock value
  const ref = sectorAvg ?? stockVal;
  const spread = Math.max(Math.abs(ref) * 0.8, 10, Math.abs(stockVal - ref) * 1.5 + 5);
  const min = ref - spread;
  const max = ref + spread;
  const range = max - min;

  const toX = (v: number) => Math.min(100, Math.max(0, ((v - min) / range) * 100));

  const stockX  = toX(stockVal);
  const sectorX = sectorAvg != null ? toX(sectorAvg) : null;

  const isGood = higher ? stockVal >= good : stockVal <= good;
  const isBad  = higher ? stockVal <= bad  : stockVal >= bad;
  const barColor = isGood ? "#4ade80" : isBad ? "#f87171" : "#facc15";

  const W = 72; const H = 16;

  return (
    <div className="flex flex-col gap-0.5" title={`${label}: stock=${stockVal.toFixed(1)}%${sectorAvg != null ? `, sector avg=${sectorAvg.toFixed(1)}%` : ""}`}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        {/* Background track */}
        <rect x="0" y={H / 2 - 2} width={W} height="4" rx="2" fill="hsl(var(--secondary))" />
        {/* Stock value bar from left to stockX */}
        <rect
          x="0" y={H / 2 - 2}
          width={(stockX / 100) * W}
          height="4" rx="2"
          fill={barColor} opacity="0.8"
        />
        {/* Sector avg tick */}
        {sectorX != null && (
          <rect
            x={(sectorX / 100) * W - 1} y={H / 2 - 5}
            width="2" height="10" rx="1"
            fill="hsl(var(--muted-foreground))" opacity="0.6"
          />
        )}
        {/* Stock value tick */}
        <rect
          x={(stockX / 100) * W - 1} y={H / 2 - 6}
          width="2" height="12" rx="1"
          fill={barColor}
        />
      </svg>
      {sectorAvg != null && (
        <div className="text-[9px] text-muted-foreground/60 leading-none">
          vs avg {sectorAvg.toFixed(1)}%
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToggleRow({
  label, value, onChange,
}: { label: string; value: ToggleLevel; onChange: (v: ToggleLevel) => void }) {
  const labelColor: Record<ToggleLevel, string> = {
    1: "text-red-400", 2: "text-orange-400", 3: "text-muted-foreground",
    4: "text-green-400", 5: "text-emerald-400",
  };
  const segColor: Record<ToggleLevel, string> = {
    1: "bg-red-500/60", 2: "bg-orange-500/50", 3: "bg-secondary",
    4: "bg-green-500/50", 5: "bg-emerald-500/60",
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={`toggle-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("text-[10px] font-medium", labelColor[value])}>{TOGGLE_LABELS[value]}</span>
      </div>
      <div className="flex gap-0.5">
        {([1, 2, 3, 4, 5] as ToggleLevel[]).map((lv) => (
          <button
            key={lv}
            onClick={() => onChange(lv)}
            className={cn(
              "flex-1 h-2 rounded-sm transition-all border",
              lv === value
                ? cn(segColor[lv], "border-foreground/30 opacity-100")
                : "bg-secondary/40 border-transparent opacity-40 hover:opacity-70",
            )}
            title={`${label}: ${TOGGLE_LABELS[lv]}`}
          />
        ))}
      </div>
    </div>
  );
}

function MetricRow({
  label, value, colorClass,
}: { label: string; value: string; colorClass: string }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-xs font-mono font-medium", colorClass)}>{value}</span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Fundamentals() {
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterSector, setFilterSector] = useState("");
  const [filterIndustry, setFilterIndustry] = useState("");
  // "" = all, "small" = <$2B, "mid" = $2B–$10B, "large" = >$10B
  const [filterMcap, setFilterMcap] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  function clearFilters() {
    setFilterRegion("");
    setFilterCountry("");
    setFilterSector("");
    setFilterIndustry("");
    setFilterMcap("");
  }

  // ── Toggle state is GLOBAL within the session — persists across stock selections ──
  const [toggles, setToggles] = useState<ToggleState>({
    tamOutlook:    3,
    regulatoryEnv: 3,
    disruptionRisk: 3,
  });

  function setToggle(key: keyof ToggleState, val: ToggleLevel) {
    setToggles((prev) => ({ ...prev, [key]: val }));
  }

  const { data: stocks = [], isLoading } = useQuery<FundamentalsRow[]>({
    queryKey: ["/api/fundamentals"],
  });

  // ── Derived filter options from data ──
  const filterOptions = useMemo(() => {
    const regions   = [...new Set(stocks.map((s) => s.region).filter(Boolean))].sort() as string[];
    const countries = [...new Set(stocks.map((s) => s.country).filter(Boolean))].sort() as string[];
    const sectors   = [...new Set(stocks.map((s) => s.sector).filter(Boolean))].sort() as string[];
    const industries = [...new Set(stocks.map((s) => s.industry).filter(Boolean))].sort() as string[];
    return { regions, countries, sectors, industries };
  }, [stocks]);

  const activeFilterCount = [filterRegion, filterCountry, filterSector, filterIndustry, filterMcap].filter(Boolean).length;

  const filteredStocks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stocks.filter((s) => {
      if (q && !s.ticker.toLowerCase().includes(q) && !s.stockName.toLowerCase().includes(q)) return false;
      if (filterRegion && s.region !== filterRegion) return false;
      if (filterCountry && s.country !== filterCountry) return false;
      if (filterSector && s.sector !== filterSector) return false;
      if (filterIndustry && s.industry !== filterIndustry) return false;
      if (filterMcap) {
        const mc = s.marketCap;
        if (filterMcap === "small"  && (mc == null || mc >= 2e9))  return false;
        if (filterMcap === "mid"    && (mc == null || mc < 2e9 || mc >= 10e9)) return false;
        if (filterMcap === "large"  && (mc == null || mc < 10e9)) return false;
      }
      return true;
    });
  }, [stocks, search, filterRegion, filterCountry, filterSector, filterIndustry, filterMcap]);

  const sel = useMemo(
    () => (selectedTicker
      ? stocks.find((s) => s.ticker === selectedTicker) ?? stocks[0] ?? null
      : stocks[0] ?? null),
    [selectedTicker, stocks],
  );

  // ── Sector peers — use default queryFn via queryKey path (auth auto-injected) ──
  const peersQueryKey = sel?.sector
    ? `/api/fundamentals/sector-peers/${encodeURIComponent(sel.sector)}`
    : null;

  const { data: peers } = useQuery<SectorPeers>({
    queryKey: [peersQueryKey],
    enabled: !!peersQueryKey,
  });

  // ── Per-ticker analyst consensus (from the stock's own analystBuy/Hold/Sell) ──
  const analystConsensusTrend = useMemo(() => {
    if (!sel) return "—";
    const buy  = sel.analystBuy  ?? 0;
    const hold = sel.analystHold ?? 0;
    const sell = sel.analystSell ?? 0;
    const tot  = buy + hold + sell;
    if (tot === 0) return "—";
    const buyRatio  = buy  / tot;
    const sellRatio = sell / tot;
    if (buyRatio >= 0.6)  return "Strong Buy Bias";
    if (buyRatio >= 0.45) return "Mild Buy Bias";
    if (sellRatio >= 0.4) return "Sell Bias";
    return "Neutral";
  }, [sel]);

  // ── Rev acceleration label ──
  const revAccelLabel = useMemo(() => {
    if (!sel || !peers) return null;
    const d = (sel.revenueGrowthYoy ?? 0) - (peers.avgRevenueGrowth ?? 0);
    if (sel.revenueGrowthYoy == null || peers.avgRevenueGrowth == null) return null;
    if (d > 5)  return "Accelerating vs Sector";
    if (d < -5) return "Lagging vs Sector";
    return "In Line with Sector";
  }, [sel, peers]);

  // ── Sector positioning score ──
  const sectorPosScore = useMemo(() => {
    if (!sel) return 50;
    const rgS = sel.revenueGrowthYoy != null
      ? (peers?.avgRevenueGrowth != null
          ? Math.min(100, Math.max(0, 50 + (sel.revenueGrowthYoy - peers.avgRevenueGrowth) * 2))
          : sel.revenueGrowthYoy > 15 ? 75 : sel.revenueGrowthYoy > 5 ? 60 : sel.revenueGrowthYoy > 0 ? 50 : 35)
      : 50;
    const gmS = sel.grossMargin != null
      ? (peers?.avgGrossMargin != null
          ? Math.min(100, Math.max(0, 50 + (sel.grossMargin - peers.avgGrossMargin) * 2))
          : sel.grossMargin > 50 ? 80 : sel.grossMargin > 30 ? 65 : sel.grossMargin > 15 ? 50 : 30)
      : 50;
    return rgS * 0.40 + gmS * 0.40 + sel.compositeScore * 0.20;
  }, [sel, peers]);

  // ── Composite analysis ──
  const analysis = useMemo(() => {
    if (!sel) return null;
    const s = sel;

    const revS  = s.revenueGrowthYoy != null ? Math.min(100, Math.max(0, s.revenueGrowthYoy * 2 + 50)) : 50;
    const gmS   = s.grossMargin != null       ? Math.min(100, Math.max(0, s.grossMargin * 1.5))         : 50;
    const pegS  = s.pegRatio != null
      ? (s.pegRatio < 1 ? 90 : s.pegRatio < 2 ? 70 : s.pegRatio < 3 ? 50 : s.pegRatio < 5 ? 30 : 10) : 50;
    const fcfS  = s.fcfYield != null ? Math.min(100, Math.max(0, s.fcfYield * 1000 + 50)) : 50;
    const fundScore = (revS + gmS + pegS + fcfS) / 4;

    const revAccS = revAccelLabel?.includes("Accelerating") ? 75 : revAccelLabel?.includes("Lagging") ? 25 : 50;
    const analS   = (() => {
      const tot = (s.analystBuy ?? 0) + (s.analystHold ?? 0) + (s.analystSell ?? 0);
      return tot > 0 ? ((s.analystBuy ?? 0) / tot) * 100 : 50;
    })();
    const cycleS  = peers?.capitalCycleStage === "Capital Return" ? 75
      : peers?.capitalCycleStage === "Early Harvest" ? 65
      : peers?.capitalCycleStage === "Mid Expansion" ? 55
      : peers?.capitalCycleStage === "Late Expansion" ? 40 : 50;
    const autoAvg = (revAccS + analS + cycleS) / 3;
    const structScore = Math.min(100, Math.max(0,
      autoAvg + TOGGLE_DELTA[toggles.tamOutlook] + TOGGLE_DELTA[toggles.regulatoryEnv] - TOGGLE_DELTA[toggles.disruptionRisk]
    ));

    const momScore = ((s.factorMomentum ?? 50) + (s.factorTrend ?? 50)) / 2;

    const finalScore =
      fundScore   * 0.30 +
      structScore * 0.30 +
      sectorPosScore * 0.20 +
      momScore    * 0.20;

    return {
      fundScore, structScore, momScore, finalScore,
      rationale: buildRationale(s, fundScore, structScore, sectorPosScore, momScore, peers),
    };
  }, [sel, peers, revAccelLabel, sectorPosScore, toggles]);

  // ── Horizon signals ──
  const horizons = useMemo(() => {
    if (!sel) return [];
    const s = sel;

    const medTermSig = (() => {
      const rgS  = s.revenueGrowthYoy != null ? (s.revenueGrowthYoy > 15 ? 80 : s.revenueGrowthYoy > 5 ? 65 : s.revenueGrowthYoy > 0 ? 50 : 30) : 55;
      const pegS = s.pegRatio != null ? (s.pegRatio < 1 ? 80 : s.pegRatio < 2 ? 65 : s.pegRatio < 3 ? 50 : 30) : 55;
      const avg  = (rgS + pegS) / 2;
      return {
        signal: avg >= 70 ? "Strong Buy" : avg >= 55 ? "Buy" : avg >= 40 ? "Hold" : "Sell",
        confidence: avg / 100,
      };
    })();

    const midLongSig = (() => {
      const gmS     = s.grossMargin != null ? Math.min(100, Math.max(0, s.grossMargin * 1.5)) : 50;
      const cycleS  = peers?.capitalCycleStage === "Capital Return" ? 75 : peers?.capitalCycleStage === "Early Harvest" ? 65 : 50;
      const avg     = (gmS + cycleS) / 2;
      return {
        signal: avg >= 70 ? "Strong Buy" : avg >= 55 ? "Buy" : avg >= 40 ? "Hold" : "Sell",
        confidence: avg / 100,
      };
    })();

    const longSig = (() => {
      const base = 50 + TOGGLE_DELTA[toggles.tamOutlook] + TOGGLE_DELTA[toggles.regulatoryEnv] - TOGGLE_DELTA[toggles.disruptionRisk];
      const cycleS = peers?.capitalCycleStage === "Capital Return" ? 75 : peers?.capitalCycleStage === "Early Harvest" ? 65 : 50;
      const avg  = Math.min(100, Math.max(0, (base + cycleS) / 2));
      return {
        signal: avg >= 70 ? "Strong Buy" : avg >= 55 ? "Buy" : avg >= 40 ? "Hold" : "Sell",
        confidence: avg / 100,
      };
    })();

    return [
      { label: "1M",  signal: s.signal20d,  confidence: s.confidence20d },
      { label: "3M",  signal: s.signal60d,  confidence: s.confidence60d },
      { label: "6M",  ...medTermSig },
      { label: "12M", ...medTermSig },
      { label: "2Y",  ...midLongSig },
      { label: "5Y",  ...midLongSig },
      { label: "10Y", ...longSig },
      { label: "20Y", ...longSig },
    ];
  }, [sel, peers, toggles]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left: Watchlist ── */}
      <aside className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-hidden" data-testid="fundamentals-watchlist">
        <div className="px-3 py-2 border-b border-border flex-shrink-0 space-y-1.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Watchlist</h2>
            <span className="text-[10px] text-muted-foreground">{filteredStocks.length}</span>
          </div>
          {/* Geography filter — always visible */}
          <select
            value={filterRegion}
            onChange={(e) => setFilterRegion(e.target.value)}
            data-testid="filter-geography"
            className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
            aria-label="Filter by Geography"
          >
            <option value="">All Geographies</option>
            {filterOptions.regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {/* Industry (Sector) filter — always visible */}
          <select
            value={filterSector}
            onChange={(e) => setFilterSector(e.target.value)}
            data-testid="filter-industry-top"
            className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
            aria-label="Filter by Industry"
          >
            <option value="">All Industries</option>
            {filterOptions.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full pl-6 pr-2 py-1 text-[11px] bg-secondary/40 border border-border/50 rounded text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
            />
          </div>
          {/* Filter toggle */}
          <button
            data-testid="filters-toggle"
            onClick={() => setFiltersOpen((v) => !v)}
            className={cn(
              "w-full flex items-center justify-between px-2 py-1 rounded text-[11px] border transition-colors",
              filtersOpen || activeFilterCount > 0
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-secondary/30 border-border/40 text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="flex items-center gap-1.5">
              <SlidersHorizontal className="w-3 h-3" />
              Filters
              {activeFilterCount > 0 && (
                <span className="bg-primary/70 text-white text-[9px] rounded-full px-1.5 py-px font-semibold">
                  {activeFilterCount}
                </span>
              )}
            </span>
            {activeFilterCount > 0 && (
              <button
                data-testid="filters-clear"
                onClick={(e) => { e.stopPropagation(); clearFilters(); }}
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
              >
                <X className="w-2.5 h-2.5" /> Clear
              </button>
            )}
          </button>

          {/* Filter panel */}
          {filtersOpen && (
            <div className="space-y-1.5 pt-0.5" data-testid="filter-panel">
              {/* Region */}
              <select
                value={filterRegion}
                onChange={(e) => setFilterRegion(e.target.value)}
                data-testid="filter-region"
                className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="">All Regions</option>
                {filterOptions.regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {/* Country */}
              <select
                value={filterCountry}
                onChange={(e) => setFilterCountry(e.target.value)}
                data-testid="filter-country"
                className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="">All Countries</option>
                {filterOptions.countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {/* Sector */}
              <select
                value={filterSector}
                onChange={(e) => setFilterSector(e.target.value)}
                data-testid="filter-sector"
                className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="">All Sectors</option>
                {filterOptions.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {/* Industry */}
              <select
                value={filterIndustry}
                onChange={(e) => setFilterIndustry(e.target.value)}
                data-testid="filter-industry"
                className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="">All Industries</option>
                {filterOptions.industries.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
              {/* Market Cap */}
              <select
                value={filterMcap}
                onChange={(e) => setFilterMcap(e.target.value)}
                data-testid="filter-mcap"
                className="w-full text-[11px] bg-secondary/40 border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="">All Market Caps</option>
                <option value="small">Small (&lt;$2B)</option>
                <option value="mid">Mid ($2B–$10B)</option>
                <option value="large">Large (&gt;$10B)</option>
              </select>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {isLoading
            ? <div className="p-2 space-y-1.5">{Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded" />)}</div>
            : filteredStocks.map((stock) => {
                const badge    = deriveBadge(stock.compositeScore);
                const isActive = stock.ticker === sel?.ticker;
                return (
                  <button
                    key={stock.ticker}
                    onClick={() => setSelectedTicker(stock.ticker)}
                    className={cn(
                      "w-full text-left px-3 py-2 border-b border-border/30 transition-colors hover:bg-secondary/50",
                      isActive && "bg-primary/10 border-l-2 border-l-primary",
                    )}
                    data-testid={`watchlist-item-${stock.ticker}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium text-foreground truncate">{stock.stockName}</span>
                      <Badge variant="outline" className={cn("text-[9px] px-1 py-0 h-4 flex-shrink-0", badge.cls)}>
                        {badge.label}
                      </Badge>
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground truncate mt-0.5">{stock.ticker}</div>
                  </button>
                );
              })
          }
        </div>
      </aside>

      {/* ── Main Panel ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {sel ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0 bg-card/50">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground truncate max-w-[220px]">{sel.stockName}</span>
                  <span className="text-xs font-mono text-muted-foreground">{sel.ticker}</span>
                  {sel.sector && (
                    <Badge variant="outline" className="text-[10px] px-1.5 h-4 text-muted-foreground">{sel.sector}</Badge>
                  )}
                </div>
                {sel.price != null && (
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs font-mono text-foreground">${sel.price.toFixed(2)}</span>
                    {sel.changePct != null && (
                      <span className={cn("text-[10px] font-mono", sel.changePct >= 0 ? "text-green-400" : "text-red-400")}>
                        {sel.changePct >= 0 ? "+" : ""}{sel.changePct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                )}
              </div>
              <Link href={`/stock/${sel.ticker}`}>
                <a className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors">
                  Full Detail <ChevronRight className="w-3 h-3" />
                </a>
              </Link>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">

              {/* Value & Growth Metrics Table + Sparklines */}
              <section data-testid="fundamentals-metrics-table">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <BarChart2 className="w-3.5 h-3.5" /> Value &amp; Growth Metrics
                  {sel.revenueGrowthYoy == null && sel.grossMargin == null && (
                    <span className="text-[10px] font-normal normal-case text-muted-foreground/50 ml-1">
                      — fundamental data not yet fetched for this stock
                    </span>
                  )}
                </h3>
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-secondary/30">
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground w-32">Metric</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Value</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Sector Avg</th>
                        <th className="text-center px-3 py-2 font-medium text-muted-foreground">vs Peers</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Signal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Rev Growth */}
                      <tr className="border-b border-border/40 hover:bg-secondary/20">
                        <td className="px-3 py-2 text-muted-foreground">Rev Growth YoY</td>
                        <td className={cn("px-3 py-2 text-right font-mono", ppColor(sel.revenueGrowthYoy, 10, 0))}>
                          {fmtPP(sel.revenueGrowthYoy)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {fmtPP(peers?.avgRevenueGrowth ?? null)}
                        </td>
                        <td className="px-3 py-2 flex justify-center">
                          <ComparisonSparkline
                            stockVal={sel.revenueGrowthYoy}
                            sectorAvg={peers?.avgRevenueGrowth ?? null}
                            label="Rev Growth"
                            good={10} bad={0}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {revAccelLabel ? (
                            <span className={cn("text-[10px] flex items-center justify-end gap-0.5",
                              revAccelLabel.includes("Accelerating") ? "text-green-400"
                                : revAccelLabel.includes("Lagging") ? "text-red-400" : "text-yellow-400"
                            )}>
                              {revAccelLabel.includes("Accelerating") ? <TrendingUp className="w-3 h-3" />
                                : revAccelLabel.includes("Lagging") ? <TrendingDown className="w-3 h-3" />
                                : <Minus className="w-3 h-3" />}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                      {/* Gross Margin */}
                      <tr className="border-b border-border/40 hover:bg-secondary/20">
                        <td className="px-3 py-2 text-muted-foreground">Gross Margin</td>
                        <td className={cn("px-3 py-2 text-right font-mono", ppColor(sel.grossMargin, 40, 20))}>
                          {fmtPP(sel.grossMargin)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {fmtPP(peers?.avgGrossMargin ?? null)}
                        </td>
                        <td className="px-3 py-2 flex justify-center">
                          <ComparisonSparkline
                            stockVal={sel.grossMargin}
                            sectorAvg={peers?.avgGrossMargin ?? null}
                            label="Gross Margin"
                            good={40} bad={20}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {sel.grossMargin != null && peers?.avgGrossMargin != null ? (
                            <span className={cn("text-[10px]",
                              sel.grossMargin >= peers.avgGrossMargin ? "text-green-400" : "text-orange-400"
                            )}>
                              {sel.grossMargin >= peers.avgGrossMargin
                                ? <TrendingUp className="w-3 h-3 inline" />
                                : <TrendingDown className="w-3 h-3 inline" />}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                      {/* PEG */}
                      <tr className="border-b border-border/40 hover:bg-secondary/20">
                        <td className="px-3 py-2 text-muted-foreground">PEG Ratio</td>
                        <td className={cn("px-3 py-2 text-right font-mono", ppColor(sel.pegRatio, 1.5, 3, false))}>
                          {fmtNum(sel.pegRatio)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">{peers?.avgPeg != null ? peers.avgPeg.toFixed(1) : "—"}</td>
                        <td className="px-3 py-2 text-center text-muted-foreground/40 text-[10px]">—</td>
                        <td className="px-3 py-2 text-right">
                          {sel.pegRatio != null ? (
                            <span className={cn("text-[10px]",
                              sel.pegRatio < 1 ? "text-emerald-400" : sel.pegRatio < 2 ? "text-green-400"
                                : sel.pegRatio < 3 ? "text-yellow-400" : "text-red-400"
                            )}>
                              {sel.pegRatio < 1 ? "Undervalued" : sel.pegRatio < 2 ? "Fair"
                                : sel.pegRatio < 3 ? "Stretched" : "Expensive"}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                      {/* FCF Yield */}
                      <tr className="hover:bg-secondary/20">
                        <td className="px-3 py-2 text-muted-foreground">FCF Yield</td>
                        <td className={cn("px-3 py-2 text-right font-mono",
                          sel.fcfYield != null
                            ? sel.fcfYield > 0.03 ? "text-green-400" : sel.fcfYield > 0 ? "text-yellow-400" : "text-red-400"
                            : "text-muted-foreground"
                        )}>
                          {fmtFrac(sel.fcfYield)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">{peers?.avgFcfYield != null ? (peers.avgFcfYield * 100).toFixed(1) + "%" : "—"}</td>
                        <td className="px-3 py-2 text-center text-muted-foreground/40 text-[10px]">—</td>
                        <td className="px-3 py-2 text-right">
                          {sel.fcfYield != null ? (
                            <span className={cn("text-[10px]",
                              sel.fcfYield > 0.05 ? "text-green-400" : sel.fcfYield > 0 ? "text-yellow-400" : "text-red-400"
                            )}>
                              {sel.fcfYield > 0.05 ? "Strong" : sel.fcfYield > 0 ? "Modest" : "Negative"}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* Sparkline legend */}
                <div className="flex items-center gap-3 mt-1.5 px-1">
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-0.5 bg-foreground/40 relative">
                      <div className="absolute inset-y-0 w-0.5 bg-muted-foreground" style={{ left: "50%" }} />
                    </div>
                    <span className="text-[9px] text-muted-foreground/60">= sector avg</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-0.5 h-2.5 bg-green-400/70 rounded" />
                    <span className="text-[9px] text-muted-foreground/60">= this stock</span>
                  </div>
                </div>
              </section>

              {/* Structural Trend Scores */}
              <section data-testid="fundamentals-structural">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5" /> Structural Trend Scores
                  {sel.sector && (
                    <span className="text-[10px] font-normal normal-case text-muted-foreground/50">— {sel.sector}</span>
                  )}
                </h3>
                {/* Automated */}
                <div className="rounded-md border border-border overflow-hidden mb-3">
                  {[
                    {
                      label: "Sector Rev Acceleration",
                      value: revAccelLabel ?? "—",
                      cls: revAccelLabel?.includes("Accelerating") ? "text-green-400"
                        : revAccelLabel?.includes("Lagging") ? "text-red-400" : "text-yellow-400",
                      icon: revAccelLabel?.includes("Accelerating") ? <TrendingUp className="w-3 h-3" />
                        : revAccelLabel?.includes("Lagging") ? <TrendingDown className="w-3 h-3" />
                        : <Minus className="w-3 h-3" />,
                    },
                    {
                      label: "Analyst Consensus",
                      value: analystConsensusTrend,
                      cls: analystConsensusTrend.includes("Buy") ? "text-green-400"
                        : analystConsensusTrend.includes("Sell") ? "text-red-400"
                        : analystConsensusTrend === "—" ? "text-muted-foreground" : "text-yellow-400",
                      icon: null,
                    },
                    {
                      label: "Capital Cycle Stage",
                      value: peers?.capitalCycleStage ?? "—",
                      cls: (peers?.capitalCycleStage === "Capital Return" || peers?.capitalCycleStage === "Early Harvest")
                        ? "text-green-400"
                        : peers?.capitalCycleStage === "Late Expansion" ? "text-orange-400" : "text-yellow-400",
                      icon: null,
                    },
                  ].map(({ label, value, cls, icon }) => (
                    <div key={label} className="flex items-center justify-between px-3 py-2 border-b border-border/40 last:border-0 hover:bg-secondary/20">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <span className={cn("text-xs font-medium flex items-center gap-1", cls)}>
                        {icon}{value}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Manual toggles — global session state, persist across stock changes */}
                <div className="rounded-md border border-border p-3 space-y-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    Manual — session only · applies to all stocks
                  </div>
                  <ToggleRow label="TAM Outlook"           value={toggles.tamOutlook}     onChange={(v) => setToggle("tamOutlook", v)} />
                  <ToggleRow label="Regulatory Environment" value={toggles.regulatoryEnv}  onChange={(v) => setToggle("regulatoryEnv", v)} />
                  <ToggleRow label="Tech Disruption Risk"   value={toggles.disruptionRisk} onChange={(v) => setToggle("disruptionRisk", v)} />
                </div>
              </section>

            </div>
          </>
        ) : isLoading ? (
          <div className="flex-1 p-4 space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No data available</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Right Panel ── */}
      <aside className="w-56 flex-shrink-0 border-l border-border flex flex-col overflow-hidden" data-testid="fundamentals-right-panel">
        {sel && analysis ? (
          <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">

            {/* Key Metrics */}
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Target className="w-3 h-3" /> Key Metrics
              </h3>
              <div className="space-y-0.5">
                <MetricRow label="Rev Growth"   value={fmtPP(sel.revenueGrowthYoy)}   colorClass={ppColor(sel.revenueGrowthYoy, 10, 0)} />
                <MetricRow label="Gross Margin" value={fmtPP(sel.grossMargin)}         colorClass={ppColor(sel.grossMargin, 40, 20)} />
                <MetricRow label="Op. Margin"   value={fmtPP(sel.operatingMargin)}     colorClass={ppColor(sel.operatingMargin, 15, 5)} />
                <MetricRow label="P/E"          value={fmtNum(sel.pe, 1)}              colorClass={ppColor(sel.pe, 15, 35, false)} />
                <MetricRow label="ROE"          value={fmtPP(sel.roe)}                 colorClass={ppColor(sel.roe, 15, 5)} />
                <MetricRow label="Debt/Equity"  value={fmtNum(sel.debtEquity)}         colorClass={ppColor(sel.debtEquity, 0.5, 2.5, false)} />
                <MetricRow label="Market Cap"   value={fmtMCap(sel.marketCap)}         colorClass="text-foreground" />
              </div>
            </section>

            {/* Sector Positioning */}
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Shield className="w-3 h-3" /> Sector Positioning
              </h3>
              <div className="rounded bg-secondary/30 p-2 space-y-2">
                <div className="flex items-end justify-between">
                  <span className="text-[10px] text-muted-foreground">Score</span>
                  <span className={cn("text-xl font-mono font-bold",
                    sectorPosScore >= 60 ? "text-green-400" : sectorPosScore >= 40 ? "text-yellow-400" : "text-red-400"
                  )}>
                    {Math.round(sectorPosScore)}
                  </span>
                </div>
                <ScoreBar score={sectorPosScore} showValue={false} size="xs" />
                {peers && (
                  <div className="text-[9px] text-muted-foreground">
                    Sector avg: {Math.round(peers.avgCompositeScore ?? 0)} · {peers.stockCount} peers
                  </div>
                )}
              </div>
            </section>

            {/* Horizon Signals */}
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Horizon Signals
              </h3>
              <div className="space-y-1">
                {horizons.map((h) => (
                  <div key={h.label} className="flex items-center justify-between py-0.5 border-b border-border/30 last:border-0">
                    <span className="text-xs text-muted-foreground w-8 flex-shrink-0">{h.label}</span>
                    <div className="flex items-center gap-2">
                      {h.confidence != null && (
                        <div className="w-10 h-1 bg-secondary rounded-full overflow-hidden">
                          <div
                            className={cn("h-full rounded-full",
                              toSignalKey(h.signal) === "buy" ? "bg-green-400"
                                : toSignalKey(h.signal) === "avoid" ? "bg-red-400" : "bg-yellow-400"
                            )}
                            style={{ width: `${Math.round(h.confidence * 100)}%` }}
                          />
                        </div>
                      )}
                      <SignalBadge signal={toSignalKey(h.signal)} size="sm" />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Final Recommendation */}
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Zap className="w-3 h-3" /> Final Recommendation
              </h3>
              <div className="rounded border border-border p-3 bg-secondary/20 space-y-3">
                {(() => {
                  const rec = scoreToRec(analysis.finalScore);
                  return (
                    <>
                      <div className={cn("text-base font-bold text-center", rec.cls)}>{rec.label}</div>
                      <div className="space-y-1.5">
                        {[
                          { label: "Fundamentals",    score: analysis.fundScore,   weight: "30%" },
                          { label: "Structural",      score: analysis.structScore, weight: "30%" },
                          { label: "Sector Position", score: sectorPosScore,       weight: "20%" },
                          { label: "Momentum",        score: analysis.momScore,    weight: "20%" },
                        ].map(({ label, score, weight }) => (
                          <div key={label}>
                            <div className="flex justify-between mb-0.5">
                              <span className="text-[10px] text-muted-foreground">{label}</span>
                              <span className="text-[10px] text-muted-foreground">{weight} · {Math.round(score)}</span>
                            </div>
                            <ScoreBar score={score} showValue={false} size="xs" />
                          </div>
                        ))}
                      </div>
                      <div className="pt-2 border-t border-border/40">
                        <div className="flex justify-between items-center mb-1.5">
                          <span className="text-[10px] text-muted-foreground">Composite</span>
                          <span className={cn("text-xs font-mono font-bold", rec.cls)}>
                            {Math.round(analysis.finalScore)} / 100
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-relaxed">{analysis.rationale}</p>
                        <p className="text-[9px] text-muted-foreground/40 mt-1 text-center">Probabilistic model output — not financial advice</p>
                      </div>
                    </>
                  );
                })()}
              </div>
            </section>

          </div>
        ) : isLoading ? (
          <div className="p-3 space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : null}
      </aside>

    </div>
  );
}
