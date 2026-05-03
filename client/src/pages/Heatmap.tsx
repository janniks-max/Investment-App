import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";

interface FundamentalsStock {
  ticker: string;
  stockName: string;
  sector: string | null;
  grossMargin: number | null;
  revenueGrowthYoy: number | null;
  analystBuy: number | null;
  analystHold: number | null;
  analystSell: number | null;
  compositeScore: number | null;
  shortPercentOfFloat: number | null;
}

// Compute a 0–1 heatmap score from available fundamentals
function fundamentalScore(s: FundamentalsStock): number | null {
  const parts: number[] = [];

  // Gross margin: 0–100% range, normalise to 0–1 capped at 80%
  if (s.grossMargin != null) parts.push(Math.min(s.grossMargin / 80, 1));

  // Rev growth: -30% to +80% → 0–1
  if (s.revenueGrowthYoy != null) parts.push(Math.min(Math.max((s.revenueGrowthYoy + 30) / 110, 0), 1));

  // Analyst buy ratio
  const total = (s.analystBuy ?? 0) + (s.analystHold ?? 0) + (s.analystSell ?? 0);
  if (total > 0) parts.push((s.analystBuy ?? 0) / total);

  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function scoreToColor(score: number | null): string {
  if (score == null) return "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]";
  // 0 = red, 0.5 = yellow, 1 = green — using tailwind-style inline HSL
  // Map to hue: 0→0 (red), 0.5→45 (amber), 1→145 (green)
  const hue = Math.round(score * 145);
  const sat = 55 + Math.round(score * 20);
  const light = 28 + Math.round(score * 10);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function scoreToTextColor(score: number | null): string {
  if (score == null) return "hsl(var(--muted-foreground))";
  return score > 0.35 ? "hsl(0,0%,92%)" : "hsl(0,0%,85%)";
}

const UNKNOWN_SECTOR = "Unknown";

export default function Heatmap() {
  const [, navigate] = useLocation();
  const [hoveredTicker, setHoveredTicker] = useState<string | null>(null);
  // "" = all, "amber" = >5%, "strong" = >20%
  const [shortTier, setShortTier] = useState<"" | "amber" | "strong">(""  );

  const { data, isLoading, error } = useQuery<FundamentalsStock[]>({
    queryKey: ["/api/fundamentals"],
    queryFn: () => apiRequest("GET", "/api/fundamentals").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const { data: signalsData } = useQuery<{ buys: { ticker: string }[]; sells: { ticker: string }[] }>({
    queryKey: ["/api/signals"],
    queryFn: () => apiRequest("GET", "/api/signals").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const insiderBuyTickers = useMemo(() => {
    if (!signalsData) return new Set<string>();
    return new Set((signalsData.buys ?? []).map((s) => s.ticker));
  }, [signalsData]);

  // Short interest tiers
  const SHORT_AMBER_THRESHOLD = 5;
  const SHORT_STRONG_THRESHOLD = 20;

  // Group by sector, optionally filtering to high-short stocks
  const sectors = useMemo(() => {
    if (!data) return [];
    const filtered = shortTier === "strong"
      ? data.filter((s) => s.shortPercentOfFloat != null && s.shortPercentOfFloat >= SHORT_STRONG_THRESHOLD)
      : shortTier === "amber"
      ? data.filter((s) => s.shortPercentOfFloat != null && s.shortPercentOfFloat >= SHORT_AMBER_THRESHOLD)
      : data;
    const map = new Map<string, FundamentalsStock[]>();
    for (const s of filtered) {
      const sector = s.sector || UNKNOWN_SECTOR;
      if (!map.has(sector)) map.set(sector, []);
      map.get(sector)!.push(s);
    }
    // Sort sectors by name, Unknown last
    return Array.from(map.entries())
      .sort(([a], [b]) => {
        if (a === UNKNOWN_SECTOR) return 1;
        if (b === UNKNOWN_SECTOR) return -1;
        return a.localeCompare(b);
      })
      .map(([sector, stocks]) => ({
        sector,
        stocks: stocks.sort((a, b) => {
          const sa = fundamentalScore(a);
          const sb = fundamentalScore(b);
          if (sa == null && sb == null) return 0;
          if (sa == null) return 1;
          if (sb == null) return -1;
          return sb - sa;
        }),
      }));
  }, [data]);

  const hoveredStock = useMemo(
    () => data?.find((s) => s.ticker === hoveredTicker) ?? null,
    [data, hoveredTicker]
  );

  const totalStocks = data?.length ?? 0;
  const withData = data?.filter((s) => fundamentalScore(s) != null).length ?? 0;

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))] text-sm">
        Loading heatmap…
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm">
        Failed to load fundamentals data.
      </div>
    );

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-[hsl(var(--foreground))]">Fundamentals Heatmap</h1>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
            {withData} / {totalStocks} stocks with data · colored by gross margin, revenue growth &amp; analyst sentiment
          </p>
        </div>
        {/* Short interest tier toggles */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShortTier((v) => v === "amber" ? "" : "amber")}
            className={`text-xs px-2 py-0.5 rounded border transition-colors ${
              shortTier === "amber" || shortTier === "strong"
                ? "border-amber-500 bg-amber-500/10 text-amber-400"
                : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-amber-500/50"
            }`}
            data-testid="toggle-short-amber"
          >
            Short &gt;5%
          </button>
          <button
            onClick={() => setShortTier((v) => v === "strong" ? "" : "strong")}
            className={`text-xs px-2 py-0.5 rounded border transition-colors ${
              shortTier === "strong"
                ? "border-red-500 bg-red-500/10 text-red-400"
                : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-red-500/50"
            }`}
            data-testid="toggle-short-strong"
          >
            Short &gt;20%
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
          <span>Weak</span>
          <div className="flex h-3 w-24 rounded overflow-hidden">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="flex-1"
                style={{ backgroundColor: scoreToColor(i / 11) }}
              />
            ))}
          </div>
          <span>Strong</span>
          <div className="ml-2 w-3 h-3 rounded-sm bg-[hsl(var(--muted))]" />
          <span>No data</span>
        </div>
      </div>

      {/* Tooltip bar */}
      <div className="h-7 flex items-center">
        {hoveredStock ? (
          <div className="text-xs text-[hsl(var(--foreground))] flex gap-4">
            <span className="font-mono font-semibold">{hoveredStock.ticker}</span>
            <span className="text-[hsl(var(--muted-foreground))]">{hoveredStock.stockName}</span>
            {hoveredStock.grossMargin != null && (
              <span>GM <span className="text-[hsl(var(--foreground))]">{hoveredStock.grossMargin.toFixed(1)}%</span></span>
            )}
            {hoveredStock.revenueGrowthYoy != null && (
              <span>RevG <span className={hoveredStock.revenueGrowthYoy >= 0 ? "text-green-400" : "text-red-400"}>{hoveredStock.revenueGrowthYoy > 0 ? "+" : ""}{hoveredStock.revenueGrowthYoy.toFixed(1)}%</span></span>
            )}
            {hoveredStock.analystBuy != null && (
              <span>Buys <span className="text-[hsl(var(--foreground))]">{hoveredStock.analystBuy}</span></span>
            )}
            {hoveredStock.shortPercentOfFloat != null && (
              <span>Short <span className={
                hoveredStock.shortPercentOfFloat >= SHORT_STRONG_THRESHOLD ? "text-red-400 font-semibold" :
                hoveredStock.shortPercentOfFloat >= SHORT_AMBER_THRESHOLD  ? "text-amber-400" :
                "text-[hsl(var(--foreground))]"
              }>{hoveredStock.shortPercentOfFloat.toFixed(1)}%</span></span>
            )}
          </div>
        ) : (
          <span className="text-xs text-[hsl(var(--muted-foreground))]">Hover a cell for details · click to open stock</span>
        )}
      </div>

      {/* Sectors */}
      <div className="space-y-5">
        {sectors.map(({ sector, stocks }) => (
          <div key={sector}>
            <div className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1.5 flex items-center gap-2">
              {sector}
              <span className="font-normal normal-case tracking-normal opacity-60">({stocks.length})</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {stocks.map((stock) => {
                const score = fundamentalScore(stock);
                const bg = scoreToColor(score);
                const fg = scoreToTextColor(score);
                const isHovered = hoveredTicker === stock.ticker;
                return (
                  <button
                    key={stock.ticker}
                    data-testid={`heatmap-cell-${stock.ticker}`}
                    onClick={() => navigate(`/stock/${stock.ticker}`)}
                    onMouseEnter={() => setHoveredTicker(stock.ticker)}
                    onMouseLeave={() => setHoveredTicker(null)}
                    className="relative rounded px-1.5 py-0.5 text-[11px] font-mono leading-tight transition-all"
                    style={{
                      backgroundColor: typeof bg === "string" && bg.startsWith("hsl(") ? bg : undefined,
                      color: fg,
                      outline: isHovered ? "1px solid hsl(var(--foreground))" : "none",
                      minWidth: "52px",
                      textAlign: "center",
                    }}
                    title={`${stock.ticker}${insiderBuyTickers.has(stock.ticker) ? " · Insider buy (14d)" : ""}${score != null ? ` · score ${(score * 100).toFixed(0)}` : " · no data"}`}
                  >
                    {insiderBuyTickers.has(stock.ticker) && (
                      <span
                        className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400"
                        aria-label="Insider buy"
                      />
                    )}
                    {stock.shortPercentOfFloat != null && stock.shortPercentOfFloat >= SHORT_STRONG_THRESHOLD && (
                      <span
                        className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-400"
                        aria-label="High short interest (>20%)"
                      />
                    )}
                    {stock.shortPercentOfFloat != null && stock.shortPercentOfFloat >= SHORT_AMBER_THRESHOLD && stock.shortPercentOfFloat < SHORT_STRONG_THRESHOLD && (
                      <span
                        className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-orange-400/70"
                        aria-label="Elevated short interest (>5%)"
                      />
                    )}
                    {stock.ticker}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
