/**
 * Opportunity Map
 * 100% independent of Buy/Watch/Avoid scoring.
 * Shows Upside Score vs Risk Score with theme/region/horizon filters.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ZAxis, Cell,
} from "recharts";
import {
  ArrowUpDown, ExternalLink, Info, Filter, TrendingUp, Shield,
  Globe, Clock, ChevronDown, ChevronUp, HelpCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip as UITooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────
interface OpportunityRow {
  ticker: string;
  name?: string;
  sector?: string;
  industry?: string;
  region?: string;
  exchange?: string;
  country?: string;
  currency?: string;
  // Scores
  upsideScore?: number;
  riskScore?: number;
  horizonScore?: number;
  horizonUpsideScore?: number;
  horizonRiskScore?: number;
  // Raw % values
  rawAnalystUpsidePct?: number | null;
  raw52wHighUpsidePct?: number | null;
  rawRevenueGrowthPct?: number | null;
  rawEpsGrowthPct?: number | null;
  rawDrawdownRiskPct?: number | null;
  rawAtrPct?: number | null;
  rawBeta?: number | null;
  rawDebtEquity?: number | null;
  thematicMultiplier?: number | null;
  // Component scores
  upsideAnalystTarget?: number;
  upside52wHigh?: number;
  upsideRevenueGrowth?: number;
  upsideEpsGrowth?: number;
  upsideValuationRerating?: number;
  riskDrawdown?: number;
  riskAtr?: number;
  riskBeta?: number;
  riskDebtEquity?: number;
  themeTags: string[];
  horizonScores?: Record<string, { upsideScore: number; riskScore: number; compositeScore: number }>;
  computedAt?: string;
}

interface OpportunityResponse {
  count: number;
  horizon: string;
  validHorizons?: string[];
  scores: OpportunityRow[];
  themeCoverage: Record<string, number>;
  disclaimer: string;
}

interface HorizonProfile {
  label: string;
  weights: Record<string, number>;
}

interface HorizonsResponse {
  horizons: string[];
  profiles: Record<string, HorizonProfile>;
}

// ─── Theme color map ──────────────────────────────────────────────────────────
const THEME_COLORS: Record<string, string> = {
  "🤖 AI/ML":                         "#6366f1",
  "⚛️ Quantum Computing":              "#a855f7",
  "🛡️ Defense & Cybersecurity":        "#ef4444",
  "☢️ Nuclear/Clean Energy":           "#f59e0b",
  "🧬 Biotech/Genomics":               "#10b981",
  "🏗️ Infrastructure & Industrials":   "#64748b",
  "🔋 Energy Transition/Batteries":    "#f97316",
  "🚀 Space & Satellite":              "#0ea5e9",
  "💊 Longevity & Anti-Aging":         "#ec4899",
  "🌊 Water & Food Security":          "#06b6d4",
  "🏙️ Urbanization & Smart Cities":    "#8b5cf6",
  "No Theme":                          "#6b7280",
};

const ALL_THEMES = Object.keys(THEME_COLORS).filter((t) => t !== "No Theme");
const REGIONS = ["All", "Americas", "Europe", "Asia-Pacific"];
const HORIZONS = ["1y", "3y", "5y", "10y", "20y"];

// Horizon weight table (hardcoded mirror of opportunityEngine.ts OPPORTUNITY_HORIZON_PROFILES)
// Kept in sync here so the methodology tooltip works without a separate API call
const HORIZON_WEIGHT_TABLE: Record<string, { label: string; weights: Record<string, number> }> = {
  "1y":  { label: "1 Year",   weights: { "Analyst Target": 0.35, "52w Upside": 0.27, "Revenue CAGR": 0.13, "EPS CAGR": 0.10, "Val. Rerating": 0.10, "Thematic": 0.05 } },
  "3y":  { label: "3 Years",  weights: { "Analyst Target": 0.25, "52w Upside": 0.17, "Revenue CAGR": 0.20, "EPS CAGR": 0.16, "Val. Rerating": 0.12, "Thematic": 0.10 } },
  "5y":  { label: "5 Years",  weights: { "Analyst Target": 0.15, "52w Upside": 0.10, "Revenue CAGR": 0.26, "EPS CAGR": 0.22, "Val. Rerating": 0.09, "Thematic": 0.18 } },
  "10y": { label: "10 Years", weights: { "Analyst Target": 0.08, "52w Upside": 0.05, "Revenue CAGR": 0.28, "EPS CAGR": 0.25, "Val. Rerating": 0.07, "Thematic": 0.27 } },
  "20y": { label: "20 Years", weights: { "Analyst Target": 0.04, "52w Upside": 0.03, "Revenue CAGR": 0.28, "EPS CAGR": 0.18, "Val. Rerating": 0.07, "Thematic": 0.40 } },
};

// ─── Sort helpers ─────────────────────────────────────────────────────────────
type SortKey = "upsideScore" | "riskScore" | "horizonScore" | "ticker" | "name" | "region";
type SortDir = "asc" | "desc";

function getThemeColor(tags: string[]): string {
  if (!tags || tags.length === 0) return THEME_COLORS["No Theme"];
  return THEME_COLORS[tags[0]] ?? THEME_COLORS["No Theme"];
}

function fmtPct(v: number | null | undefined, prefix = ""): string {
  if (v === null || v === undefined) return "—";
  return `${prefix}${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function fmtRaw(v: number | null | undefined, dec = 2): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(dec);
}

function ScoreBar({ value, color }: { value?: number; color: string }) {
  const pct = Math.round(Math.min(100, Math.max(0, value ?? 0)));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground w-7 text-right">{pct}</span>
    </div>
  );
}

// ─── Custom scatter dot ───────────────────────────────────────────────────────
function CustomDot(props: any) {
  const { cx, cy, payload } = props;
  const color = getThemeColor(payload.themeTags ?? []);
  const r = Math.max(4, Math.min(10, 4 + (payload.horizonScore ?? 50) / 20));
  return (
    <circle
      cx={cx} cy={cy} r={r}
      fill={color} fillOpacity={0.8}
      stroke={color} strokeWidth={1.5}
      strokeOpacity={0.5}
      style={{ cursor: "pointer" }}
    />
  );
}

// ─── Scatter Tooltip ──────────────────────────────────────────────────────────
function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d: OpportunityRow = payload[0].payload;
  const color = getThemeColor(d.themeTags ?? []);
  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-lg text-xs max-w-[240px]">
      <div className="font-semibold text-foreground mb-0.5">{d.ticker}</div>
      {d.name && <div className="text-muted-foreground mb-2 truncate">{d.name}</div>}
      <div className="space-y-1 mb-2">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Upside (horizon)</span>
          <span className="font-medium text-green-500">{Math.round(d.horizonUpsideScore ?? d.upsideScore ?? 0)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Risk</span>
          <span className="font-medium text-red-500">{Math.round(d.horizonRiskScore ?? d.riskScore ?? 0)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Composite</span>
          <span className="font-medium text-primary">{Math.round(d.horizonScore ?? 0)}</span>
        </div>
      </div>
      {/* Raw % values */}
      <div className="border-t border-border pt-2 space-y-0.5 text-[10px]">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Analyst Target</span>
          <span className="tabular-nums">{fmtPct(d.rawAnalystUpsidePct)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">52w Upside</span>
          <span className="tabular-nums">{fmtPct(d.raw52wHighUpsidePct)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Revenue CAGR</span>
          <span className="tabular-nums">{fmtPct(d.rawRevenueGrowthPct)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">EPS CAGR</span>
          <span className="tabular-nums">{fmtPct(d.rawEpsGrowthPct)}</span>
        </div>
        {d.thematicMultiplier && d.thematicMultiplier > 1.0 && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Thematic</span>
            <span className="tabular-nums text-primary">{d.thematicMultiplier.toFixed(1)}x</span>
          </div>
        )}
      </div>
      {d.themeTags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {d.themeTags.map((t) => (
            <span key={t} className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: color + "20", color }}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Methodology Tooltip ──────────────────────────────────────────────────────
function MethodologyTooltip({ selectedHorizon }: { selectedHorizon: string }) {
  return (
    <TooltipProvider>
      <UITooltip>
        <TooltipTrigger asChild>
          <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-secondary/50">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Methodology</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[340px] p-3" side="bottom" align="end">
          <div className="text-xs space-y-2">
            <div className="font-semibold text-foreground">Horizon Weight Table</div>
            <p className="text-muted-foreground text-[11px]">
              At longer horizons, thematic positioning and growth CAGR dominate.
              At short horizons, analyst targets and recent price momentum matter more.
            </p>
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1 text-muted-foreground font-medium">Horizon</th>
                  <th className="text-right py-1 text-muted-foreground font-medium">Target</th>
                  <th className="text-right py-1 text-muted-foreground font-medium">52w</th>
                  <th className="text-right py-1 text-muted-foreground font-medium">Rev</th>
                  <th className="text-right py-1 text-muted-foreground font-medium">EPS</th>
                  <th className="text-right py-1 text-muted-foreground font-medium">Theme</th>
                </tr>
              </thead>
              <tbody>
                {HORIZONS.map((h) => {
                  const p = HORIZON_WEIGHT_TABLE[h];
                  const isActive = h === selectedHorizon;
                  return (
                    <tr key={h} className={cn("border-b border-border/50", isActive && "bg-primary/10")}>
                      <td className={cn("py-1 font-medium", isActive ? "text-primary" : "text-foreground")}>
                        {p.label}
                      </td>
                      {["Analyst Target", "52w Upside", "Revenue CAGR", "EPS CAGR", "Thematic"].map((k) => (
                        <td key={k} className={cn("py-1 text-right tabular-nums", isActive ? "text-primary" : "text-muted-foreground")}>
                          {Math.round((p.weights[k] ?? 0) * 100)}%
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="text-[10px] text-muted-foreground pt-1 border-t border-border">
              Scores are absolute self-referential — two stocks can both score 60 if both have ~60% analyst upside. Not ranked against each other.
            </div>
          </div>
        </TooltipContent>
      </UITooltip>
    </TooltipProvider>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function OpportunityMap() {
  const [selectedRegion, setSelectedRegion] = useState("All");
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null);
  const [selectedHorizon, setSelectedHorizon] = useState("3y");
  const [sortKey, setSortKey] = useState<SortKey>("horizonScore");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<OpportunityResponse>({
    queryKey: ["/api/opportunity", selectedRegion, selectedTheme, selectedHorizon],
    queryFn: async () => {
      const params = new URLSearchParams({ horizon: selectedHorizon });
      if (selectedRegion !== "All") params.set("region", selectedRegion);
      if (selectedTheme) params.set("theme", selectedTheme);
      const res = await apiRequest("GET", `/api/opportunity?${params}`);
      return res.json();
    },
    refetchInterval: 300000, // 5min
  });

  const scores = data?.scores ?? [];

  // Sort table
  const sortedScores = useMemo(() => {
    return [...scores].sort((a, b) => {
      let av = a[sortKey] as any;
      let bv = b[sortKey] as any;
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [scores, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 text-muted-foreground" />;
    return sortDir === "desc"
      ? <ChevronDown className="w-3 h-3 text-primary" />
      : <ChevronUp className="w-3 h-3 text-primary" />;
  };

  // Theme coverage sorted by count
  const themeCoverage = Object.entries(data?.themeCoverage ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <TooltipProvider>
    <div className="p-4 space-y-4 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Opportunity Map</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Independent of Buy/Watch/Avoid signals · Absolute self-referential scoring
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <MethodologyTooltip selectedHorizon={selectedHorizon} />
          <div className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-1.5">
            <Info className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Not financial advice. Data: Yahoo Finance (delayed).</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Region filter */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground mr-1">
          <Globe className="w-3.5 h-3.5" />
          <span>Region:</span>
        </div>
        {REGIONS.map((r) => (
          <button
            key={r}
            onClick={() => setSelectedRegion(r)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              selectedRegion === r
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            )}
            data-testid={`filter-region-${r.toLowerCase()}`}
          >
            {r}
          </button>
        ))}

        <div className="w-px h-4 bg-border mx-1" />

        {/* Horizon filter */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground mr-1">
          <Clock className="w-3.5 h-3.5" />
          <span>Horizon:</span>
        </div>
        {HORIZONS.map((h) => (
          <button
            key={h}
            onClick={() => setSelectedHorizon(h)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              selectedHorizon === h
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            )}
            data-testid={`filter-horizon-${h}`}
          >
            {h}
          </button>
        ))}

        <div className="w-px h-4 bg-border mx-1" />

        {/* Theme filter */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground mr-1">
          <Filter className="w-3.5 h-3.5" />
          <span>Theme:</span>
        </div>
        <button
          onClick={() => setSelectedTheme(null)}
          className={cn(
            "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
            selectedTheme === null
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-muted-foreground hover:text-foreground"
          )}
        >
          All
        </button>
        {ALL_THEMES.map((t) => (
          <button
            key={t}
            onClick={() => setSelectedTheme(selectedTheme === t ? null : t)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors border",
              selectedTheme === t
                ? "text-white border-transparent"
                : "bg-transparent text-muted-foreground hover:text-foreground border-border"
            )}
            style={selectedTheme === t ? { background: THEME_COLORS[t], borderColor: THEME_COLORS[t] } : {}}
            data-testid={`filter-theme-${t}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Stats bar */}
      {!isLoading && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span><span className="text-foreground font-medium tabular-nums">{scores.length}</span> stocks</span>
          {themeCoverage.slice(0, 4).map(([theme, count]) => (
            <span key={theme}>
              <span className="text-foreground font-medium tabular-nums">{count}</span> {theme}
            </span>
          ))}
        </div>
      )}

      {/* Main grid: scatter + table */}
      <div className="grid grid-cols-1 xl:grid-cols-[480px_1fr] gap-4">
        {/* Scatter chart */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-foreground">Upside vs. Risk</div>
            <div className="text-xs text-muted-foreground">Dot size = Composite Score ({selectedHorizon})</div>
          </div>

          {isLoading ? (
            <Skeleton className="w-full h-64" />
          ) : error ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              No data yet — trigger a refresh to compute scores
            </div>
          ) : scores.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              No opportunity scores yet. Trigger a data refresh to populate this map.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="horizonUpsideScore"
                  name="Upside"
                  domain={[0, 100]}
                  label={{
                    value: `← Lower Upside    Upside Score (${selectedHorizon})    Higher Upside →`,
                    position: "insideBottom",
                    offset: -25,
                    fontSize: 10,
                    fill: "hsl(var(--muted-foreground))",
                  }}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  type="number"
                />
                <YAxis
                  dataKey="horizonRiskScore"
                  name="Risk"
                  domain={[0, 100]}
                  label={{
                    value: "Risk Score →",
                    angle: -90,
                    position: "insideLeft",
                    offset: 10,
                    fontSize: 10,
                    fill: "hsl(var(--muted-foreground))",
                  }}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  type="number"
                />
                <ZAxis dataKey="horizonScore" range={[20, 120]} />
                <Tooltip content={<ScatterTooltip />} />
                <Scatter
                  data={scores}
                  shape={<CustomDot />}
                  isAnimationActive={false}
                >
                  {scores.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={getThemeColor(entry.themeTags ?? [])} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          )}

          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(THEME_COLORS).map(([theme, color]) => (
              <div key={theme} className="flex items-center gap-1 text-xs text-muted-foreground">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <span>{theme}</span>
              </div>
            ))}
          </div>
          {/* Chart footnote */}
          <p className="text-[10px] text-muted-foreground mt-2">
            Best-in-class zone: top-right (high upside, high risk tolerance) or bottom-right (high upside, low risk).
          </p>
        </div>

        {/* Sortable table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto overflow-y-auto max-h-[480px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card/95 backdrop-blur-sm border-b border-border z-10">
                <tr>
                  <th className="text-left px-3 py-2.5 text-muted-foreground font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("ticker")}>
                      Ticker <SortIcon k="ticker" />
                    </button>
                  </th>
                  <th className="text-left px-2 py-2.5 text-muted-foreground font-medium hidden md:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("name")}>
                      Name <SortIcon k="name" />
                    </button>
                  </th>
                  <th className="text-left px-2 py-2.5 text-muted-foreground font-medium hidden lg:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("region")}>
                      Region <SortIcon k="region" />
                    </button>
                  </th>
                  <th className="text-right px-2 py-2.5 text-muted-foreground font-medium">
                    <button className="flex items-center gap-1 ml-auto" onClick={() => toggleSort("upsideScore")}>
                      <TrendingUp className="w-3 h-3" /> Upside <SortIcon k="upsideScore" />
                    </button>
                  </th>
                  <th className="text-right px-2 py-2.5 text-muted-foreground font-medium">
                    <button className="flex items-center gap-1 ml-auto" onClick={() => toggleSort("riskScore")}>
                      <Shield className="w-3 h-3" /> Risk <SortIcon k="riskScore" />
                    </button>
                  </th>
                  <th className="text-right px-2 py-2.5 text-muted-foreground font-medium">
                    <button className="flex items-center gap-1 ml-auto" onClick={() => toggleSort("horizonScore")}>
                      <Clock className="w-3 h-3" /> {selectedHorizon} <SortIcon k="horizonScore" />
                    </button>
                  </th>
                  <th className="text-left px-2 py-2.5 text-muted-foreground font-medium hidden xl:table-cell">Themes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}>
                        {[...Array(7)].map((_, j) => (
                          <td key={j} className="px-3 py-2.5">
                            <Skeleton className="h-4 w-full" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : sortedScores.map((row) => {
                      const themeColor = getThemeColor(row.themeTags ?? []);
                      const upside = Math.round(row.horizonUpsideScore ?? row.upsideScore ?? 0);
                      const risk = Math.round(row.horizonRiskScore ?? row.riskScore ?? 0);
                      const hs = Math.round(row.horizonScore ?? 0);
                      const isExpanded = expandedRow === row.ticker;
                      return (
                        <>
                          <tr
                            key={row.ticker}
                            className="hover:bg-secondary/50 cursor-pointer transition-colors"
                            onClick={() => setExpandedRow(isExpanded ? null : row.ticker)}
                            data-testid={`opp-row-${row.ticker}`}
                          >
                            <td className="px-3 py-2">
                              <Link href={`/stock/${row.ticker}`} onClick={(e) => e.stopPropagation()}>
                                <a className="font-mono font-semibold text-primary hover:underline" data-testid={`opp-ticker-${row.ticker}`}>
                                  {row.ticker}
                                </a>
                              </Link>
                            </td>
                            <td className="px-2 py-2 text-muted-foreground hidden md:table-cell truncate max-w-[140px]">
                              {row.name ?? "—"}
                            </td>
                            <td className="px-2 py-2 text-muted-foreground hidden lg:table-cell">
                              {row.region ?? "—"}
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-16 hidden sm:block">
                                  <ScoreBar value={upside} color="#22c55e" />
                                </div>
                                <span className={cn("font-semibold tabular-nums", upside >= 65 ? "text-green-500" : upside >= 45 ? "text-foreground" : "text-red-500")}>
                                  {upside}
                                </span>
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-16 hidden sm:block">
                                  <ScoreBar value={risk} color="#ef4444" />
                                </div>
                                <span className={cn("font-semibold tabular-nums", risk >= 65 ? "text-red-500" : risk >= 40 ? "text-amber-500" : "text-green-500")}>
                                  {risk}
                                </span>
                              </div>
                            </td>
                            <td className="px-2 py-2 text-right">
                              <span className={cn("font-bold tabular-nums", hs >= 60 ? "text-primary" : hs >= 40 ? "text-foreground" : "text-muted-foreground")}>
                                {hs}
                              </span>
                            </td>
                            <td className="px-2 py-2 hidden xl:table-cell">
                              <div className="flex flex-wrap gap-1">
                                {(row.themeTags ?? []).slice(0, 2).map((t) => (
                                  <span
                                    key={t}
                                    className="px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap"
                                    style={{ background: (THEME_COLORS[t] ?? "#666") + "25", color: THEME_COLORS[t] ?? "#666" }}
                                  >
                                    {t}
                                  </span>
                                ))}
                                {(row.themeTags?.length ?? 0) > 2 && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-muted-foreground">
                                    +{(row.themeTags?.length ?? 0) - 2}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${row.ticker}-detail`} className="bg-secondary/30">
                              <td colSpan={7} className="px-4 py-3">
                                {/* Raw % values */}
                                <div className="mb-3">
                                  <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1.5">
                                    Raw Values (absolute, self-referential)
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2 text-xs">
                                    <div className="bg-card rounded p-2 border border-border/60">
                                      <div className="text-muted-foreground text-[10px] mb-0.5">Analyst Target</div>
                                      <div className={cn("font-semibold tabular-nums", (row.rawAnalystUpsidePct ?? 0) > 0 ? "text-green-500" : "text-muted-foreground")}>
                                        {fmtPct(row.rawAnalystUpsidePct)}
                                      </div>
                                    </div>
                                    <div className="bg-card rounded p-2 border border-border/60">
                                      <div className="text-muted-foreground text-[10px] mb-0.5">52w Upside</div>
                                      <div className={cn("font-semibold tabular-nums", (row.raw52wHighUpsidePct ?? 0) > 0 ? "text-green-500" : "text-muted-foreground")}>
                                        {fmtPct(row.raw52wHighUpsidePct)}
                                      </div>
                                    </div>
                                    <div className="bg-card rounded p-2 border border-border/60">
                                      <div className="text-muted-foreground text-[10px] mb-0.5">Revenue CAGR</div>
                                      <div className={cn("font-semibold tabular-nums", (row.rawRevenueGrowthPct ?? 0) > 0 ? "text-green-500" : "text-muted-foreground")}>
                                        {fmtPct(row.rawRevenueGrowthPct)}
                                      </div>
                                    </div>
                                    <div className="bg-card rounded p-2 border border-border/60">
                                      <div className="text-muted-foreground text-[10px] mb-0.5">EPS CAGR</div>
                                      <div className={cn("font-semibold tabular-nums", (row.rawEpsGrowthPct ?? 0) > 0 ? "text-green-500" : "text-muted-foreground")}>
                                        {fmtPct(row.rawEpsGrowthPct)}
                                      </div>
                                    </div>
                                    <div className="bg-card rounded p-2 border border-border/60">
                                      <div className="text-muted-foreground text-[10px] mb-0.5">Thematic</div>
                                      <div className={cn("font-semibold tabular-nums", (row.thematicMultiplier ?? 1) > 1 ? "text-primary" : "text-muted-foreground")}>
                                        {row.thematicMultiplier != null ? `${row.thematicMultiplier.toFixed(1)}x` : "—"}
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                {/* Component score bars — Upside */}
                                <div className="mb-3">
                                  <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1.5">
                                    Upside Components
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                                    <div>
                                      <div className="text-muted-foreground mb-1">Analyst Target</div>
                                      <ScoreBar value={row.upsideAnalystTarget} color="#6366f1" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">52w Upside</div>
                                      <ScoreBar value={row.upside52wHigh} color="#8b5cf6" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">Revenue CAGR</div>
                                      <ScoreBar value={row.upsideRevenueGrowth} color="#22c55e" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">EPS CAGR</div>
                                      <ScoreBar value={row.upsideEpsGrowth} color="#10b981" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">Val. Rerating</div>
                                      <ScoreBar value={row.upsideValuationRerating} color="#f59e0b" />
                                    </div>
                                  </div>
                                </div>

                                {/* Component score bars — Risk */}
                                <div className="mb-3">
                                  <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1.5">
                                    Risk Components
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                                    <div>
                                      <div className="text-muted-foreground mb-1">Drawdown Risk</div>
                                      <ScoreBar value={row.riskDrawdown} color="#ef4444" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">ATR Volatility</div>
                                      <ScoreBar value={row.riskAtr} color="#f97316" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">Beta: {row.rawBeta != null ? row.rawBeta.toFixed(2) : "—"}</div>
                                      <ScoreBar value={row.riskBeta} color="#f59e0b" />
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground mb-1">D/E: {row.rawDebtEquity != null ? row.rawDebtEquity.toFixed(2) : "—"}</div>
                                      <ScoreBar value={row.riskDebtEquity} color="#ef4444" />
                                    </div>
                                  </div>
                                </div>

                                {/* Theme tags + meta */}
                                {(row.themeTags?.length ?? 0) > 0 && (
                                  <div className="mb-2 flex flex-wrap gap-1">
                                    {(row.themeTags ?? []).map((t) => (
                                      <span
                                        key={t}
                                        className="px-2 py-0.5 rounded-full text-[11px]"
                                        style={{ background: (THEME_COLORS[t] ?? "#666") + "25", color: THEME_COLORS[t] ?? "#666" }}
                                      >
                                        {t}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                  Computed: {row.computedAt ? new Date(row.computedAt).toLocaleString() : "—"}
                                  {" · "}
                                  <Link href={`/stock/${row.ticker}`}>
                                    <a className="text-primary hover:underline inline-flex items-center gap-0.5">
                                      View Detail <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                {!isLoading && scores.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <TrendingUp className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <div>No opportunity scores computed yet.</div>
                      <div className="text-xs mt-1">Trigger a data refresh from the header to populate this map.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      {data?.disclaimer && (
        <p className="text-[10px] text-muted-foreground text-center border-t border-border pt-2">
          {data.disclaimer}
        </p>
      )}
    </div>
    </TooltipProvider>
  );
}
