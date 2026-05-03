import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Link } from "wouter";
import { ArrowLeft, RefreshCw, AlertTriangle, Info, Clock, Newspaper, CalendarDays, ExternalLink, TrendingUp, TrendingDown } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ReferenceLine, ResponsiveContainer, Cell, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar, Legend
} from "recharts";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
// Tabs removed — bar/radar toggle uses custom buttons instead
import SignalBadge from "@/components/SignalBadge";
import ScoreBar from "@/components/ScoreBar";
import DataTag from "@/components/DataTag";
import { useToast } from "@/hooks/use-toast";
import { useCurrency, formatMonetary } from "@/lib/currencyContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StockDetailData {
  ticker: string;
  snapshot: any;
  recommendation: any;
  horizonScores?: Record<string, { score: number; confidence: number; label: string }>;
  history: any[];
  disclaimer: string;
}

type Horizon = "20" | "60" | "120" | "250";

interface NewsItem {
  uuid: string;
  title: string | null;
  publisher: string | null;
  link: string | null;
  publishedAt: string | null;
  relatedTickers: string[];
  thumbnailUrl: string | null;
  type: string;
}

interface NewsData {
  ticker: string;
  news: NewsItem[];
  earningsDate: string | null;
  fetchedAt: string;
  source: string;
  disclaimer: string;
  error?: string;
}

// ─── Factor attribution config ────────────────────────────────────────────────

// Factor weights mirror HORIZON_WEIGHTS in rankingEngine.ts exactly
const FACTORS = [
  { key: "factorMomentum",  label: "Momentum",  weight: { "20": 0.35, "60": 0.25, "120": 0.15, "250": 0.08 }, color: "#22d3ee", desc: "Medium-term relative strength (20/60/120d returns). Dominant factor for short-term horizons (35% at 20d). Falls to 8% at 250d as long-run momentum is weak signal." },
  { key: "factorTrend",     label: "Trend",     weight: { "20": 0.25, "60": 0.20, "120": 0.14, "250": 0.10 }, color: "#818cf8", desc: "Price vs. SMA20/50/200, MACD, RSI alignment. Strong at 20d (25%), declines as longer-term structural trend matters less." },
  { key: "factorEarnings",  label: "Earnings",  weight: { "20": 0.20, "60": 0.25, "120": 0.24, "250": 0.22 }, color: "#34d399", desc: "EPS/revenue growth, analyst revisions, price target upside. Relatively stable across all horizons (20-25%) — earnings quality is consistently important." },
  { key: "factorValuation", label: "Valuation", weight: { "20": 0.08, "60": 0.14, "120": 0.22, "250": 0.30 }, color: "#fb923c", desc: "P/E, P/B, EV/EBITDA, 52w range. Minimal at 20d (8%) — valuation rarely resolves in 4 weeks. Dominant at 250d (30%) as mean-reversion drives long-horizon returns." },
  { key: "factorQuality",   label: "Quality",   weight: { "20": 0.07, "60": 0.11, "120": 0.20, "250": 0.25 }, color: "#e879f9", desc: "Gross margin, operating margin, ROE, D/E, FCF generation. Minor at 20d (7%), major at 250d (25%) — high-quality compounders show their edge over time." },
  { key: "factorSentiment", label: "Sentiment", weight: { "20": 0.05, "60": 0.05, "120": 0.05, "250": 0.05 }, color: "#fbbf24", desc: "Volume vs. average, analyst tone, news presence. Minor factor at all horizons (5%) — short-term noise signal only." },
] as const;

// Horizon-adjusted score formula (mirrors backend HORIZON_WEIGHTS exactly)
function getHorizonScore(rec: any, h: Horizon): number {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const mom  = rec?.factorMomentum  ?? null;
  const trend = rec?.factorTrend    ?? null;
  const earn = rec?.factorEarnings  ?? null;
  const val  = rec?.factorValuation ?? null;
  const qual = rec?.factorQuality   ?? null;
  const sent = rec?.factorSentiment ?? null;

  const weightMap: Record<Horizon, Record<string, number>> = {
    "20":  { momentum: 0.35, trend: 0.25, earnings: 0.20, valuation: 0.08, quality: 0.07, sentiment: 0.05 },
    "60":  { momentum: 0.25, trend: 0.20, earnings: 0.25, valuation: 0.14, quality: 0.11, sentiment: 0.05 },
    "120": { momentum: 0.15, trend: 0.14, earnings: 0.24, valuation: 0.22, quality: 0.20, sentiment: 0.05 },
    "250": { momentum: 0.08, trend: 0.10, earnings: 0.22, valuation: 0.30, quality: 0.25, sentiment: 0.05 },
  };
  const volPenaltyMult: Record<Horizon, number> = { "20": 0.35, "60": 0.22, "120": 0.14, "250": 0.08 };

  const factors = [mom, trend, earn, val, qual, sent];
  const weights = Object.values(weightMap[h]);
  let weightedSum = 0, weightUsed = 0;
  factors.forEach((f, i) => {
    if (f !== null) { weightedSum += f * weights[i]; weightUsed += weights[i]; }
  });
  let score = weightUsed > 0 ? clamp(weightedSum / weightUsed) : (rec?.compositeScore ?? 50);

  // Apply volatility penalty
  const vol = rec?.factorVolatility ?? null;
  if (vol !== null && vol > 50) score = clamp(score - (vol - 50) * volPenaltyMult[h]);

  return Math.round(score * 10) / 10;
}

// Contribution = factor_score * effective_weight (0-100 scale contribution)
function getContributions(rec: any, h: Horizon) {
  return FACTORS.map((f) => {
    const raw = rec?.[f.key] ?? null;
    const w   = f.weight[h];
    const contribution = raw !== null ? raw * w : null;
    // Deviation from neutral (50 * weight)
    const neutral  = 50 * w;
    const delta    = contribution !== null ? contribution - neutral : null;
    return { ...f, raw, contribution, neutral, delta, weight: w };
  });
}

// Signal for a given horizon from stored signals
function getStoredSignal(rec: any, h: Horizon): string {
  return rec?.[`signal${h}d`] ?? "watch";
}

// Horizon labels
const HORIZON_LABEL: Record<Horizon, string> = {
  "20":  "20d — Momentum & catalyst",
  "60":  "60d — Earnings & momentum",
  "120": "120d — Quality & valuation",
  "250": "250d — Quality & valuation (1yr)",
};
const HORIZON_EMPHASIS: Record<Horizon, string> = {
  "20":  "Momentum 35% · Trend 25% · Earnings 20% · Valuation 8% · Quality 7%",
  "60":  "Earnings 25% · Momentum 25% · Trend 20% · Valuation 14% · Quality 11%",
  "120": "Earnings 24% · Valuation 22% · Quality 20% · Trend 14% · Momentum 15%",
  "250": "Valuation 30% · Quality 25% · Earnings 22% · Trend 10% · Momentum 8%",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: any, dec = 2, suffix = ""): string {
  if (n === null || n === undefined) return "data unavailable";
  const v = typeof n === "number" ? n.toFixed(dec) : n;
  return v + suffix;
}
function fmtPct(n: any): string {
  if (n === null || n === undefined) return "data unavailable";
  const v = parseFloat(n);
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}
function fmtLarge(n: any): string {
  if (!n) return "data unavailable";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9)  return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6)  return "$" + (n / 1e6).toFixed(2) + "M";
  return "$" + n.toLocaleString();
}

function DataRow({ label, value, note }: { label: string; value: string; note?: string }) {
  const isMissing = value === "data unavailable";
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-xs tabular-nums font-medium", isMissing ? "text-muted-foreground italic" : "text-foreground")}>
        {value}
        {note && <span className="text-[10px] text-muted-foreground ml-1">({note})</span>}
      </span>
    </div>
  );
}

// ─── Factor Attribution Chart ─────────────────────────────────────────────────

function FactorAttributionChart({ rec }: { rec: any }) {
  const [chartHorizon, setChartHorizon] = useState<Horizon>("60");
  const [chartType, setChartType] = useState<"bar" | "radar">("bar");

  const contributions = getContributions(rec, chartHorizon);
  const horizonScore  = getHorizonScore(rec, chartHorizon);
  const storedSignal  = getStoredSignal(rec, chartHorizon);

  // Bar chart data: one bar per factor showing raw score (vs neutral 50)
  const barData = contributions.map((f) => ({
    name: f.label,
    score: f.raw !== null ? Math.round(f.raw * 10) / 10 : null,
    contribution: f.contribution !== null ? Math.round(f.contribution * 10) / 10 : null,
    delta: f.delta !== null ? Math.round(f.delta * 10) / 10 : null,
    weight: Math.round(f.weight * 100),
    color: f.color,
    fill: f.raw !== null
      ? (f.raw >= 65 ? "#22c55e" : f.raw <= 35 ? "#ef4444" : "#94a3b8")
      : "#334155",
  }));

  // Radar chart data: normalized scores 0-100 across all horizons for comparison
  const radarData = FACTORS.map((f) => ({
    factor: f.label,
    "20d":  f.weight["20"] !== 0 ? (rec?.[f.key] ?? 50) : 0,
    "60d":  f.weight["60"] !== 0 ? (rec?.[f.key] ?? 50) : 0,
    "120d": f.weight["120"] !== 0 ? (rec?.[f.key] ?? 50) : 0,
    "250d": f.weight["250"] !== 0 ? (rec?.[f.key] ?? 50) : 0,
  }));

  const CustomBarTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    const contrib = contributions.find(c => c.label === d.name);
    return (
      <div className="bg-card border border-border rounded p-2.5 text-xs shadow-lg max-w-[220px]">
        <p className="font-semibold mb-1">{d.name}</p>
        <p className="text-muted-foreground">Raw score: <span className="text-foreground font-mono">{d.score ?? "N/A"} / 100</span></p>
        <p className="text-muted-foreground">Weight ({chartHorizon}d): <span className="text-foreground font-mono">{d.weight}%</span></p>
        <p className="text-muted-foreground">Contribution: <span className={cn("font-mono", d.delta >= 0 ? "text-green-500" : "text-red-500")}>
          {d.delta !== null ? (d.delta >= 0 ? "+" : "") + d.delta?.toFixed(1) : "N/A"} vs neutral
        </span></p>
        <p className="text-muted-foreground mt-1 text-[10px] leading-relaxed">{contrib?.desc}</p>
      </div>
    );
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="p-3 pb-2 border-b border-border">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            Factor Attribution
            <Tooltip>
              <TooltipTrigger><Info className="w-3.5 h-3.5 text-muted-foreground" /></TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                Shows the raw score for each factor (0–100) and how much it contributes to the horizon-adjusted composite score.
                Longer horizons increase the weight on Valuation and Quality; shorter horizons emphasize Momentum and Trend.
                Green bars = score above neutral (50); red = below neutral.
              </TooltipContent>
            </Tooltip>
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Chart type toggle */}
            <div className="flex items-center bg-secondary rounded-md overflow-hidden border border-border">
              <button onClick={() => setChartType("bar")}
                className={cn("px-2.5 py-1 text-xs transition-colors",
                  chartType === "bar" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                Bar
              </button>
              <button onClick={() => setChartType("radar")}
                className={cn("px-2.5 py-1 text-xs transition-colors",
                  chartType === "radar" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                Radar
              </button>
            </div>
            {/* Horizon selector */}
            <div className="flex items-center bg-secondary rounded-md overflow-hidden border border-border">
              {(["20", "60", "120", "250"] as Horizon[]).map((h) => (
                <button key={h} onClick={() => setChartHorizon(h)}
                  className={cn("px-2 py-1 text-xs transition-colors",
                    chartHorizon === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {h}d
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* Context line */}
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
          <span>{chartHorizon}d horizon score: <span className="text-foreground font-semibold tabular-nums">{horizonScore.toFixed(1)}</span></span>
          <span>Signal: <SignalBadge signal={storedSignal} /></span>
          <span className="text-[10px] opacity-70">Hover bars for details</span>
        </div>
      </CardHeader>
      <CardContent className="p-3">
        {chartType === "bar" ? (
          <>
            {/* Bar chart: factor raw scores colored by quality */}
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--muted-foreground, #94a3b8)" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted-foreground, #94a3b8)" }} />
                <ReferenceLine y={50} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" label={{ value: "neutral", position: "right", fontSize: 9, fill: "rgba(255,255,255,0.3)" }} />
                <RechartsTooltip content={<CustomBarTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="score" radius={[3, 3, 0, 0]}>
                  {barData.map((d, i) => (
                    <Cell key={i} fill={d.score === null ? "#334155" : d.score >= 65 ? "#22c55e" : d.score <= 35 ? "#ef4444" : "#64748b"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            {/* Weight table below chart */}
            <div className="mt-3">
              <div className="text-[10px] text-muted-foreground mb-1.5 font-medium">Factor weights for {chartHorizon}-day horizon</div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                {contributions.map((f) => (
                  <div key={f.key} className="bg-secondary rounded p-1.5 text-center">
                    <div className="text-[10px] text-muted-foreground truncate">{f.label}</div>
                    <div className="text-xs font-semibold tabular-nums" style={{ color: f.color }}>
                      {Math.round(f.weight * 100)}%
                    </div>
                    <div className={cn("text-[10px] tabular-nums",
                      f.raw === null ? "text-muted-foreground italic"
                        : f.raw >= 65 ? "text-green-500"
                        : f.raw <= 35 ? "text-red-500"
                        : "text-muted-foreground")}>
                      {f.raw !== null ? f.raw.toFixed(0) : "N/A"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          /* Radar chart: compare all 4 horizons for this stock */
          <>
            <div className="text-[11px] text-muted-foreground mb-2">Factor scores compared across all horizons (same raw data, different weighting)</div>
            <ResponsiveContainer width="100%" height={240}>
              <RadarChart data={radarData}>
                <PolarGrid stroke="rgba(255,255,255,0.1)" />
                <PolarAngleAxis dataKey="factor" tick={{ fontSize: 10, fill: "var(--muted-foreground, #94a3b8)" }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 8, fill: "rgba(255,255,255,0.3)" }} />
                <Radar name="20d" dataKey="20d" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.08} strokeWidth={1.5} dot={false} />
                <Radar name="60d" dataKey="60d" stroke="#34d399" fill="#34d399" fillOpacity={0.08} strokeWidth={1.5} dot={false} />
                <Radar name="120d" dataKey="120d" stroke="#fb923c" fill="#fb923c" fillOpacity={0.08} strokeWidth={1.5} dot={false} />
                <Radar name="250d" dataKey="250d" stroke="#e879f9" fill="#e879f9" fillOpacity={0.08} strokeWidth={1.5} dot={false} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </RadarChart>
            </ResponsiveContainer>
            <div className="text-[10px] text-muted-foreground mt-1 italic">
              The radar shows the same raw factor scores for all horizons — the horizon only changes how those scores are weighted to produce the composite.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

// ─── News & Earnings Panel ────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatEarningsDate(dateStr: string | null): string {
  if (!dateStr) return "data unavailable";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const diffDays = Math.round((d.getTime() - Date.now()) / 86400000);
    const formatted = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    if (diffDays > 0 && diffDays <= 90) return `${formatted} (→ in ${diffDays}d)`;
    if (diffDays > 90) return `${formatted} (upcoming)`;
    if (diffDays >= -30) return `${formatted} (${Math.abs(diffDays)}d ago)`;
    return formatted;
  } catch { return dateStr; }
}

function NewsEarningsPanel({ ticker }: { ticker: string }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery<NewsData>({
    queryKey: ["/api/news", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/news/${encodeURIComponent(ticker)}?count=8`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const earnings = data?.earningsDate ?? null;
  const news     = data?.news ?? [];
  const hasError = !!error || !!data?.error;

  return (
    <Card className="bg-card border-border" data-testid="panel-news-earnings">
      <CardHeader className="p-3 pb-2 border-b border-border">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Newspaper className="w-3.5 h-3.5" />
            News &amp; Earnings Calendar
            <Tooltip>
              <TooltipTrigger><Info className="w-3.5 h-3.5 text-muted-foreground" /></TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                Headlines and earnings dates are <strong>sourced data</strong> from Yahoo Finance.
                They are displayed as-is and clearly separate from model scores and signals.
                Headline sentiment is <strong>not</strong> used in model scoring.
              </TooltipContent>
            </Tooltip>
          </CardTitle>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            data-testid="button-refresh-news"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          </button>
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          Sourced data · Yahoo Finance · Not used in model scoring
          {data?.fetchedAt && <span className="ml-1 opacity-60">· fetched {timeAgo(data.fetchedAt)}</span>}
        </div>
      </CardHeader>

      <CardContent className="p-3 space-y-3">
        {/* Earnings date */}
        <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-2.5">
          <CalendarDays className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">
              Next Earnings Date
            </div>
            {isLoading ? (
              <div className="h-4 w-36 bg-secondary animate-pulse rounded" />
            ) : (
              <div className="text-xs font-semibold tabular-nums text-foreground">
                {formatEarningsDate(earnings)}
              </div>
            )}
            <div className="text-[10px] text-muted-foreground mt-0.5 italic">
              Source: Yahoo Finance fundamentals
            </div>
          </div>
        </div>

        {/* Headlines */}
        <div>
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Recent Headlines
          </div>

          {isLoading && (
            <div className="space-y-3">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3.5 bg-secondary animate-pulse rounded w-full" />
                  <div className="h-3 bg-secondary animate-pulse rounded w-28" />
                </div>
              ))}
            </div>
          )}

          {!isLoading && hasError && (
            <div className="text-xs text-muted-foreground italic py-1">
              Could not fetch headlines from Yahoo Finance.
              {data?.error && <span className="block text-[10px] mt-0.5 opacity-60">{data.error}</span>}
            </div>
          )}

          {!isLoading && !hasError && news.length === 0 && (
            <div className="text-xs text-muted-foreground italic py-1">
              No recent headlines found for {ticker}.
            </div>
          )}

          {!isLoading && news.length > 0 && (
            <div className="divide-y divide-border">
              {news.map((item) => (
                <div
                  key={item.uuid}
                  className="py-2.5 first:pt-0 last:pb-0"
                  data-testid={`news-item-${item.uuid}`}
                >
                  <div className="flex items-start gap-2.5">
                    {item.thumbnailUrl && (
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        crossOrigin="anonymous"
                        className="w-10 h-10 rounded object-cover flex-shrink-0 bg-secondary"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      {item.link ? (
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group text-xs font-medium text-foreground hover:text-primary transition-colors leading-snug flex items-start gap-1"
                          data-testid={`link-news-${item.uuid}`}
                        >
                          <span className="line-clamp-2">{item.title ?? "Untitled"}</span>
                          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-60 transition-opacity" />
                        </a>
                      ) : (
                        <p className="text-xs font-medium text-foreground leading-snug line-clamp-2">
                          {item.title ?? "Untitled"}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        {item.publisher && (
                          <span className="text-[10px] text-muted-foreground">{item.publisher}</span>
                        )}
                        {item.publishedAt && (
                          <>
                            <span className="text-[10px] text-muted-foreground/40">·</span>
                            <span className="text-[10px] text-muted-foreground">
                              {timeAgo(item.publishedAt)}
                            </span>
                          </>
                        )}
                        {item.relatedTickers.length > 1 && (
                          <>
                            <span className="text-[10px] text-muted-foreground/40">·</span>
                            <span className="text-[10px] text-muted-foreground/50">
                              {item.relatedTickers.filter((t: string) => t !== ticker).slice(0, 3).join(" ")}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <div className="text-[10px] text-muted-foreground italic border-t border-border pt-2">
          {data?.disclaimer ?? "Headlines and earnings dates are sourced data only. Not used in model scoring."}
        </div>
      </CardContent>
    </Card>
  );
}


// ─── Insider Transactions Card ──────────────────────────────────────────────
function InsiderTransactionsCard({ ticker }: { ticker: string }) {
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: rows, isLoading } = useQuery<any[]>({
    queryKey: ["/api/insider", ticker],
    queryFn: () => apiRequest("GET", `/api/insider/${ticker}`).then((r) => r.json()),
    staleTime: 10 * 60 * 1000,
  });

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const resp = await apiRequest("POST", `/api/insider/${ticker}/refresh`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed");
      qc.invalidateQueries({ queryKey: ["/api/insider", ticker] });
      toast({ title: "Insider data refreshed", description: `Fetched ${data.fetched} transactions` });
    } catch (e: any) {
      toast({ title: "Refresh failed", description: e.message, variant: "destructive" });
    } finally {
      setRefreshing(false);
    }
  }

  const hasData = rows && rows.length > 0;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="p-3 pb-2 border-b border-border">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">Insider Transactions</CardTitle>
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-[10px] text-muted-foreground"
            onClick={handleRefresh}
            disabled={refreshing}
            data-testid="button-insider-refresh"
          >
            <RefreshCw className={cn("w-3 h-3 mr-1", refreshing && "animate-spin")} />
            {refreshing ? "Fetching…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-3">
        {isLoading ? (
          <div className="space-y-1">{[0,1,2].map(i => <Skeleton key={i} className="h-5 w-full" />)}</div>
        ) : !hasData ? (
          <p className="text-xs text-muted-foreground italic">
            No insider data cached. Click Refresh to fetch from Yahoo Finance.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[480px]">
              <thead>
                <tr className="border-b border-border text-[10px] text-muted-foreground">
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">Insider</th>
                  <th className="px-2 py-1.5 text-left">Type</th>
                  <th className="px-2 py-1.5 text-right">Shares</th>
                  <th className="px-2 py-1.5 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => {
                  const isBuy = /buy|purchas/i.test(t.transactionType || "");
                  const isSell = /sale|sell/i.test(t.transactionType || "");
                  return (
                    <tr key={i} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{t.transactionDate || "—"}</td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium truncate max-w-[160px]">{t.insiderName || "—"}</div>
                        {t.relation && <div className="text-[10px] text-muted-foreground">{t.relation}</div>}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className={cn(
                          "inline-flex items-center gap-1",
                          isBuy ? "text-green-400" : isSell ? "text-red-400" : "text-muted-foreground"
                        )}>
                          {isBuy && <TrendingUp className="w-3 h-3" />}
                          {isSell && <TrendingDown className="w-3 h-3" />}
                          {t.transactionType || "—"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {t.shares != null ? t.shares.toLocaleString() : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {t.value != null ? ("$" + fmtLarge(t.value)) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="text-[10px] text-muted-foreground mt-2 italic">
          Last 5 transactions from Yahoo Finance. Data may be delayed. Not financial advice.
        </div>
      </CardContent>
    </Card>
  );
}

export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { displayCurrency } = useCurrency();

  const { data, isLoading, error } = useQuery<StockDetailData>({
    queryKey: ["/api/stock", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stock/${ticker}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/stock/${ticker}/refresh`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/stock", ticker] });
      qc.invalidateQueries({ queryKey: ["/api/recommendations"] });
      toast({ title: `${ticker} refreshed` });
    },
    onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
  });

  const snap = data?.snapshot;
  const rec  = data?.recommendation;
  const horizonScores = data?.horizonScores;
  const history = data?.history ?? [];

  const flagsParsed: string[] = (() => {
    try { return JSON.parse(rec?.riskFlags || "[]") || []; } catch { return []; }
  })();

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="page-stock-detail">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-48" />)}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4">
        <Link href="/"><a className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"><ArrowLeft className="w-4 h-4" /> Back</a></Link>
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          No data found for {ticker}. Click Refresh to fetch data.
          <Button variant="outline" size="sm" className="ml-3" onClick={() => refreshMutation.mutate()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Fetch data
          </Button>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="p-4 space-y-4" data-testid="page-stock-detail">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Link href="/"><a className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"><ArrowLeft className="w-4 h-4" /></a></Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-foreground tabular-nums">{ticker}</h1>
                {snap?.dataFreshness && <DataTag freshness={snap.dataFreshness} />}
              </div>
              <div className="text-xs text-muted-foreground">
                {snap?.dataSource ? `Source: ${snap.dataSource}` : ""}
                {snap?.fetchedAt ? ` · Fetched ${new Date(snap.fetchedAt).toLocaleTimeString()}` : ""}
              </div>
            </div>
          </div>
          <Button
            variant="outline" size="sm" className="gap-1.5 text-xs"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            data-testid="button-refresh-stock"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", refreshMutation.isPending && "animate-spin")} />
            {refreshMutation.isPending ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {/* Price header */}
        {snap?.price && (
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-start justify-between flex-wrap gap-4">
                <div>
                  <div className="text-2xl font-bold tabular-nums text-foreground">
                    {(() => {
                      const priceEur = (snap as any).priceEur ?? null;
                      const priceUsd = (snap as any).priceUsd ?? null;
                      const nativeCurrency = (snap as any).nativeCurrency ?? null;
                      if (priceEur != null || priceUsd != null) {
                        const { primary, secondary, native } = formatMonetary(priceEur, priceUsd, displayCurrency, {
                          nativePrice: snap.price,
                          nativeCurrency,
                          decimals: 2,
                        });
                        return (
                          <>
                            {primary}
                            {secondary && <span className="text-base font-normal text-muted-foreground ml-2">{secondary}</span>}
                            {native && nativeCurrency !== displayCurrency && (
                              <div className="text-xs font-normal text-muted-foreground mt-0.5">{native}</div>
                            )}
                          </>
                        );
                      }
                      return "$" + snap.price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    })()}
                  </div>
                  <div className={cn("text-sm font-medium tabular-nums", snap.changePct >= 0 ? "text-positive" : "text-negative")}>
                    {snap.changePct >= 0 ? "+" : ""}{snap.changePct?.toFixed(2)}% today
                    {snap.change && <span className="text-muted-foreground ml-1">({snap.change >= 0 ? "+" : ""}{snap.change?.toFixed(2)})</span>}
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                  {[
                    { label: "Open",   val: snap.open   ? "$" + fmt(snap.open)   : "—" },
                    { label: "High",   val: snap.high   ? "$" + fmt(snap.high)   : "—" },
                    { label: "Low",    val: snap.low    ? "$" + fmt(snap.low)    : "—" },
                    { label: "Volume", val: snap.volume?.toLocaleString() ?? "—" },
                  ].map(({ label, val }) => (
                    <div key={label}>
                      <div className="text-muted-foreground">{label}</div>
                      <div className="tabular-nums font-medium">{val}</div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left col: signals + factors + risk */}
          <div className="lg:col-span-1 space-y-4">
            {/* Model Signals */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  Model Signals
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3.5 h-3.5 text-muted-foreground" /></TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">
                      Probabilistic model output. Not a price prediction. Labels are rank-based (percentile bucketing), not fixed score thresholds.
                    </TooltipContent>
                  </Tooltip>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2">
                {rec ? (
                  <>
                    {(["20", "60", "120", "250"] as Horizon[]).map((h) => {
                      const sig   = getStoredSignal(rec, h);
                      const liveScore = horizonScores?.[`d${h}`]?.score ?? getHorizonScore(rec, h);
                      const conf  = horizonScores?.[`d${h}`]?.confidence ?? rec?.[`confidence${h}d`];
                      return (
                        <Tooltip key={h}>
                          <TooltipTrigger className="w-full">
                            <div className="flex items-center justify-between py-0.5">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-muted-foreground w-16">{h}-day</span>
                                <span className="text-[10px] text-muted-foreground hidden sm:inline truncate max-w-[120px]">{HORIZON_LABEL[h].split("— ")[1]}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs tabular-nums font-mono text-muted-foreground">{liveScore.toFixed(1)}</span>
                                <SignalBadge signal={sig} />
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {conf ? Math.round(conf) + "% conf" : "—"}
                                </span>
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="text-xs font-medium mb-1">{HORIZON_LABEL[h]}</p>
                            <p className="text-xs text-muted-foreground">{HORIZON_EMPHASIS[h]}</p>
                            <p className="text-xs mt-1">Score: {liveScore.toFixed(1)}/100 · Confidence: {conf ? Math.round(conf) : "—"}%</p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                    <Separator className="my-2" />
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Base Composite Score (60d)</div>
                      <ScoreBar score={rec.compositeScore} />
                      <div className="text-[10px] text-muted-foreground mt-1">
                        Stored base score. Horizon adjustments applied live on each request.
                      </div>
                    </div>
                    {/* Fix #11A: data coverage indicator */}
                    {rec.dataCoverage != null && (
                      <div className="pt-2 border-t border-border">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">Data coverage</span>
                          <span className={"text-xs font-semibold " + (rec.coverageTier === "high" ? "text-green-500" : rec.coverageTier === "medium" ? "text-yellow-500" : "text-red-500")}>
                            {Math.round(rec.dataCoverage)}% ({rec.coverageTier ?? "—"})
                          </span>
                        </div>
                        <div className="w-full bg-secondary rounded-full h-1 mt-1 overflow-hidden">
                          <div className={"h-full rounded-full " + (rec.coverageTier === "high" ? "bg-green-500" : rec.coverageTier === "medium" ? "bg-yellow-500" : "bg-red-500")}
                            style={{ width: rec.dataCoverage + "%" }} />
                        </div>
                        {rec.coverageTier === "low" && (
                          <div className="text-[10px] text-amber-400 mt-1">⚠ Low coverage — Buy label suppressed</div>
                        )}
                        {rec.sectorGroup && rec.sectorGroup !== "generic" && (
                          <div className="text-[10px] text-muted-foreground mt-1">Sector: {rec.sectorGroup}</div>
                        )}
                      </div>
                    )}
                    {/* Horizon score comparison bar */}
                    <div className="pt-1">
                      <div className="text-[10px] text-muted-foreground mb-1.5 font-medium">Horizon score spread — differences prove per-horizon recompute</div>
                      <div className="space-y-1">
                        {(["20", "60", "120", "250"] as Horizon[]).map((h) => {
                          const s = horizonScores?.[`d${h}`]?.score ?? getHorizonScore(rec, h);
                          return (
                            <div key={h} className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground w-8">{h}d</span>
                              <div className="flex-1 bg-secondary rounded-full h-1.5 overflow-hidden">
                                <div className="h-full rounded-full bg-primary" style={{ width: `${s}%` }} />
                              </div>
                              <span className="text-[10px] font-mono text-foreground w-10 text-right tabular-nums">{s.toFixed(1)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground italic">No model output yet — click Refresh</div>
                )}
              </CardContent>
            </Card>

            {/* Risk Flags */}
            {flagsParsed.length > 0 && (
              <Card className="bg-card border-amber-500/20">
                <CardHeader className="p-3 pb-2 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-amber-500">
                    <AlertTriangle className="w-3.5 h-3.5" /> Risk Flags
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  <ul className="space-y-1">
                    {flagsParsed.map((flag, i) => (
                      <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                        <span className="text-amber-500 flex-shrink-0">•</span>
                        <span>{flag}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Model Explanation */}
            {rec?.explanation && (
              <Card className="bg-card border-border">
                <CardHeader className="p-3 pb-2 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Model Explanation</CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">{rec.explanation}</p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right col: attribution chart + data panels */}
          <div className="lg:col-span-2 space-y-4">
            {/* ⭐ Factor Attribution Chart */}
            {rec && <FactorAttributionChart rec={rec} />}

            {/* Technical Indicators */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold">Technical Indicators</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6">
                  <div>
                    <DataRow label="RSI (14)" value={fmt(snap?.rsi14, 1)} note={snap?.rsi14 > 70 ? "overbought" : snap?.rsi14 < 30 ? "oversold" : undefined} />
                    <DataRow label="MACD" value={fmt(snap?.macd)} />
                    <DataRow label="MACD Signal" value={fmt(snap?.macdSignal)} />
                    <DataRow label="ATR (14)" value={fmt(snap?.atr14)} />
                  </div>
                  <div>
                    <DataRow label="SMA 20" value={snap?.sma20 ? "$" + fmt(snap.sma20) : "data unavailable"} />
                    <DataRow label="SMA 50" value={snap?.sma50 ? "$" + fmt(snap.sma50) : "data unavailable"} />
                    <DataRow label="SMA 200" value={snap?.sma200 ? "$" + fmt(snap.sma200) : "data unavailable"} />
                    <DataRow label="Beta" value={fmt(snap?.beta)} />
                  </div>
                  <div>
                    <DataRow label="52w High" value={snap?.high52w ? "$" + fmt(snap.high52w) : "data unavailable"} />
                    <DataRow label="52w Low" value={snap?.low52w ? "$" + fmt(snap.low52w) : "data unavailable"} />
                    {snap?.high52w && snap?.price && snap.high52w > 0 && (() => {
                      const pct = ((snap.high52w - snap.price) / snap.high52w) * 100;
                      const isNear = pct <= 5;
                      const isFar  = pct > 30;
                      return (
                        <div className="flex items-start py-0.5 gap-1">
                          <span className="text-[10px] text-muted-foreground w-28 flex-shrink-0">% from 52w High</span>
                          <span className={cn(
                            "text-xs font-medium tabular-nums",
                            isNear ? "text-green-400" : isFar ? "text-amber-400" : "text-foreground"
                          )}>
                            -{pct.toFixed(1)}%
                            {isNear && <span className="ml-1 text-[10px] text-green-400">(near high ↗)</span>}
                            {isFar  && <span className="ml-1 text-[10px] text-amber-400">(review)</span>}
                          </span>
                        </div>
                      );
                    })()}
                    <DataRow label="Avg Vol (20d)" value={snap?.avgVolume20d?.toLocaleString() ?? "data unavailable"} />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Historical Returns */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold">Historical Returns (computed)</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {[
                    { label: "1D", val: snap?.ret1d },
                    { label: "5D", val: snap?.ret5d },
                    { label: "20D", val: snap?.ret20d },
                    { label: "60D", val: snap?.ret60d },
                    { label: "120D", val: snap?.ret120d },
                    { label: "250D", val: snap?.ret250d },
                  ].map(({ label, val }) => (
                    <div key={label} className="bg-secondary rounded-md p-2 text-center">
                      <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                      {val !== null && val !== undefined ? (
                        <div className={cn("text-xs font-semibold tabular-nums", val >= 0 ? "text-positive" : "text-negative")}>
                          {val >= 0 ? "+" : ""}{val.toFixed(1)}%
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">—</div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2 italic">
                  Computed from Yahoo Finance chart data. Not adjusted for dividends.
                </div>
              </CardContent>
            </Card>

            {/* Fundamentals */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold">Fundamentals</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6">
                  <div>
                    <DataRow label="P/E Ratio" value={fmt(snap?.pe, 1)} />
                    <DataRow label="P/B Ratio" value={fmt(snap?.pb, 2)} />
                    <DataRow label="EV/EBITDA" value={fmt(snap?.evEbitda, 1)} />
                    <DataRow label="EPS (TTM)" value={snap?.eps ? "$" + fmt(snap.eps) : "data unavailable"} />
                  </div>
                  <div>
                    <DataRow label="Gross Margin" value={fmt(snap?.grossMargin, 1, "%")} />
                    <DataRow label="Oper. Margin" value={fmt(snap?.operatingMargin, 1, "%")} />
                    <DataRow label="ROE" value={fmt(snap?.roe, 1, "%")} />
                    <DataRow label="Debt/Equity" value={fmt(snap?.debtEquity, 2)} />
                  </div>
                  <div>
                    <DataRow label="Rev. Growth" value={fmtPct(snap?.revenueGrowthYoy)} />
                    <DataRow label="EPS Growth" value={fmtPct(snap?.epsGrowthYoy)} />
                    <DataRow label="Div. Yield" value={fmt(snap?.dividendYield, 2, "%")} />
                    <DataRow label="Free Cash Flow" value={fmtLarge(snap?.freeCashFlow)} />
                    <DataRow label="Short % Float" value={snap?.shortPercentOfFloat != null ? fmt(snap.shortPercentOfFloat, 1, "%") : "data unavailable"} />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Analyst Data */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold">Analyst Estimates</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6">
                  <div>
                    <DataRow label="Buy ratings" value={fmt(snap?.analystBuy, 0)} />
                    <DataRow label="Hold ratings" value={fmt(snap?.analystHold, 0)} />
                    <DataRow label="Sell ratings" value={fmt(snap?.analystSell, 0)} />
                  </div>
                  <div>
                    <DataRow label="Price Target" value={snap?.priceTarget ? "$" + fmt(snap.priceTarget) : "data unavailable"} />
                    <DataRow label="Upside" value={snap?.priceTarget && snap?.price
                      ? fmtPct(((snap.priceTarget - snap.price) / snap.price) * 100)
                      : "data unavailable"} />
                    <DataRow label="Earnings Date" value={snap?.earningsDate || "data unavailable"} />
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground mt-2 italic">
                  Analyst data from Yahoo Finance. Data may be delayed or unavailable for non-US listings.
                </div>
              </CardContent>
            </Card>

            {/* Signal History (Audit Trail) */}
            {history.length > 0 && (
              <Card className="bg-card border-border">
                <CardHeader className="p-3 pb-2 border-b border-border">
                  <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> Signal History (Audit Trail)
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[500px]">
                      <thead>
                        <tr className="border-b border-border text-[10px] text-muted-foreground">
                          <th className="px-3 py-2 text-left">Generated At</th>
                          <th className="px-2 py-2 text-center">20d</th>
                          <th className="px-2 py-2 text-center">60d</th>
                          <th className="px-2 py-2 text-center">120d</th>
                          <th className="px-2 py-2 text-center">250d</th>
                          <th className="px-2 py-2 text-right">Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((h: any, i: number) => (
                          <tr key={i} className="border-b border-border last:border-0 hover:bg-secondary/50">
                            <td className="px-3 py-1.5 text-muted-foreground">{new Date(h.generatedAt).toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-center"><SignalBadge signal={h.signal20d} /></td>
                            <td className="px-2 py-1.5 text-center"><SignalBadge signal={h.signal60d} /></td>
                            <td className="px-2 py-1.5 text-center"><SignalBadge signal={h.signal120d} /></td>
                            <td className="px-2 py-1.5 text-center"><SignalBadge signal={h.signal250d} /></td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{h.compositeScore?.toFixed(1) ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* News & Earnings Calendar */}
            {ticker && <NewsEarningsPanel ticker={ticker} />}

            {/* Insider Transactions */}
            <InsiderTransactionsCard ticker={ticker!} />

            {/* Data Attribution */}
            <div className="rounded-md border border-border bg-card/50 p-3">
              <div className="text-[10px] text-muted-foreground space-y-1">
                <div className="font-medium text-muted-foreground mb-1">Data Attribution & Audit</div>
                <div>• <strong>Source:</strong> {snap?.dataSource ?? "Not yet fetched"}</div>
                <div>• <strong>Freshness:</strong> {snap?.dataFreshness ?? "—"} (Yahoo Finance: ~15min delay or EOD)</div>
                <div>• <strong>Fetched:</strong> {snap?.fetchedAt ? new Date(snap.fetchedAt).toLocaleString() : "—"}</div>
                <div>• <strong>Model generated:</strong> {rec?.generatedAt ? new Date(rec.generatedAt).toLocaleString() : "—"}</div>
                <div>• <strong>Sourced data:</strong> prices, volume, fundamentals from Yahoo Finance API</div>
                <div>• <strong>Computed features:</strong> returns, SMAs, RSI, MACD, ATR — calculated from raw price series</div>
                <div>• <strong>Model opinions:</strong> factor scores, signals, composite score — probabilistic estimates only</div>
                {snap?.errorMessage && <div className="text-amber-500">• <strong>Fetch note:</strong> {snap.errorMessage}</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
