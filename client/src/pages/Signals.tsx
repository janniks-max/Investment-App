import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Zap, TrendingUp, TrendingDown, User, Calendar, Hash, AlertTriangle, Users, Star, ArrowUpDown, Clock } from "lucide-react";

interface SignalRow {
  ticker: string;
  transaction_date: string;
  insider_name: string | null;
  relation: string | null;
  transaction_type: string | null;
  shares: number | null;
  value: number | null;
  fetched_at: string;
  stock_name: string | null;
  sector: string | null;
  signal_kind: "buy" | "sell";
  multi_insider: boolean;
  large_purchase: boolean;
}

interface SignalsResponse {
  buys: SignalRow[];
  sells: SignalRow[];
  lastUpdated: string | null;
  cutoffDate: string;
}

function formatValue(v: number | null): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function formatShares(s: number | null): string {
  if (s == null) return "—";
  return s.toLocaleString();
}

function daysAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "1 day ago";
  return `${diff} days ago`;
}

function formatLastUpdated(ts: string | null): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

type SortKey = "date" | "value";

function sortRows(rows: SignalRow[], by: SortKey): SignalRow[] {
  return [...rows].sort((a, b) => {
    if (by === "value") {
      return (b.value ?? 0) - (a.value ?? 0);
    }
    return (b.transaction_date ?? "").localeCompare(a.transaction_date ?? "");
  });
}

function BuyCard({ s, onClick }: { s: SignalRow; onClick: () => void }) {
  return (
    <div
      data-testid={`signal-buy-${s.ticker}`}
      className="group rounded-lg border border-amber-500/20 bg-slate-800/60 hover:bg-slate-800/90 hover:border-amber-500/50 transition-all duration-150 cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-stretch overflow-hidden rounded-lg">
        <div className="w-1 shrink-0 bg-amber-500/70 rounded-l-lg" />
        <div className="flex-1 px-4 py-3">
          {/* Badges row */}
          {(s.large_purchase || s.multi_insider) && (
            <div className="flex items-center gap-2 mb-2">
              {s.large_purchase && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full px-2 py-0.5">
                  <Star className="w-2.5 h-2.5" />
                  Large Purchase
                </span>
              )}
              {s.multi_insider && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-full px-2 py-0.5">
                  <Users className="w-2.5 h-2.5" />
                  Multiple Insiders
                </span>
              )}
            </div>
          )}

          <div className="flex items-start justify-between gap-3">
            {/* Left: ticker + name */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0">
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold text-sm">
                  {s.ticker.slice(0, 4)}
                </span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white text-sm">{s.ticker}</span>
                  {s.sector && (
                    <span className="text-[10px] text-slate-500 bg-slate-700/60 px-1.5 py-0.5 rounded">
                      {s.sector}
                    </span>
                  )}
                </div>
                {s.stock_name && (
                  <p className="text-xs text-slate-400 truncate">{s.stock_name}</p>
                )}
              </div>
            </div>
            {/* Right: value + date */}
            <div className="text-right shrink-0">
              <div className="text-sm font-semibold text-amber-300">{formatValue(s.value)}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{daysAgo(s.transaction_date)}</div>
            </div>
          </div>

          {/* Bottom row */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <User className="w-3 h-3 text-slate-500" />
              {s.insider_name ?? "—"}
            </span>
            <span className="text-slate-500">{s.relation ?? "—"}</span>
            <span className="flex items-center gap-1">
              <Hash className="w-3 h-3 text-slate-500" />
              {formatShares(s.shares)} shares
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3 text-slate-500" />
              {s.transaction_date}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SellCard({ s, onClick }: { s: SignalRow; onClick: () => void }) {
  return (
    <div
      data-testid={`signal-sell-${s.ticker}`}
      className="group rounded-lg border border-red-500/20 bg-slate-800/40 hover:bg-slate-800/70 hover:border-red-500/40 transition-all duration-150 cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-stretch overflow-hidden rounded-lg">
        <div className="w-1 shrink-0 bg-red-500/50 rounded-l-lg" />
        <div className="flex-1 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0">
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 font-bold text-sm">
                  {s.ticker.slice(0, 4)}
                </span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white text-sm">{s.ticker}</span>
                  {s.sector && (
                    <span className="text-[10px] text-slate-500 bg-slate-700/60 px-1.5 py-0.5 rounded">
                      {s.sector}
                    </span>
                  )}
                </div>
                {s.stock_name && (
                  <p className="text-xs text-slate-400 truncate">{s.stock_name}</p>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm font-semibold text-red-400">{formatValue(s.value)}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{daysAgo(s.transaction_date)}</div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <User className="w-3 h-3 text-slate-500" />
              {s.insider_name ?? "—"}
            </span>
            <span className="text-slate-500">{s.relation ?? "—"}</span>
            <span className="flex items-center gap-1">
              <Hash className="w-3 h-3 text-slate-500" />
              {formatShares(s.shares)} shares
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3 text-slate-500" />
              {s.transaction_date}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Signals() {
  const [, setLocation] = useLocation();
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [showSells, setShowSells] = useState(true);

  const { data, isLoading, error } = useQuery<SignalsResponse>({
    queryKey: ["/api/signals"],
    queryFn: () => apiRequest("GET", "/api/signals").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const buys = sortRows(data?.buys ?? [], sortBy);
  const sells = sortRows(data?.sells ?? [], sortBy);

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/40">
          <Zap className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-white leading-tight">Signals</h1>
          <p className="text-xs text-slate-400">Insider transactions — last 30 days</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Last updated */}
          {data?.lastUpdated && (
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="w-3 h-3" />
              {formatLastUpdated(data.lastUpdated)}
            </span>
          )}
          {/* Sort toggle */}
          <button
            data-testid="sort-toggle"
            onClick={() => setSortBy((s) => (s === "date" ? "value" : "date"))}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 border border-slate-700 rounded-full px-3 py-1 transition-colors"
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortBy === "date" ? "By date" : "By value"}
          </button>
        </div>
      </div>

      {/* Explainer */}
      <div className="rounded-lg border border-amber-500/25 bg-amber-950/30 px-4 py-3 text-xs text-amber-200/80 leading-relaxed">
        <span className="font-semibold text-amber-300">Why this matters:</span> Open-market purchases signal insiders putting their own capital on the line. These transactions boost stock scores in the recommendation engine. Refreshed automatically every Monday and Thursday.
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-slate-800/50 animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          Failed to load signals. {String(error)}
        </div>
      )}

      {/* Buys section */}
      {!isLoading && !error && data && (
        <>
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-semibold text-white">
              Insider Buys
            </span>
            <span className="text-xs text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-2 py-0.5">
              {buys.length}
            </span>
          </div>

          {buys.length === 0 ? (
            <div className="rounded-lg border border-amber-500/20 bg-slate-800/30 px-6 py-10 text-center">
              <Zap className="w-8 h-8 text-amber-500/30 mx-auto mb-2" />
              <p className="text-slate-400 text-sm">No open-market insider buys in the last 30 days.</p>
              <p className="text-slate-500 text-xs mt-1">The insider feed refreshes Mon &amp; Thu at 06:00 UTC.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {buys.map((s, idx) => (
                <BuyCard
                  key={`${s.ticker}-${s.transaction_date}-${idx}`}
                  s={s}
                  onClick={() => setLocation(`/stock/${s.ticker}`)}
                />
              ))}
            </div>
          )}

          {/* Sell warnings */}
          {sells.length > 0 && (
            <div className="pt-2 space-y-2">
              <button
                data-testid="sells-toggle"
                onClick={() => setShowSells((v) => !v)}
                className="flex items-center gap-2 w-full text-left"
              >
                <AlertTriangle className="w-4 h-4 text-red-400/70" />
                <span className="text-sm font-semibold text-slate-400">
                  Sell Warnings
                </span>
                <span className="text-xs text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-2 py-0.5">
                  {sells.length}
                </span>
                <span className="text-xs text-slate-600 ml-1">≥$100K · {showSells ? "hide" : "show"}</span>
              </button>

              {showSells && (
                <div className="space-y-2">
                  {sells.map((s, idx) => (
                    <SellCard
                      key={`${s.ticker}-${s.transaction_date}-${idx}`}
                      s={s}
                      onClick={() => setLocation(`/stock/${s.ticker}`)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer count */}
          <p className="text-center text-xs text-slate-600 pt-1">
            {buys.length} buy{buys.length !== 1 ? "s" : ""}
            {sells.length > 0 ? `, ${sells.length} sell warning${sells.length !== 1 ? "s" : ""}` : ""}
            {" "}· last 30 days
          </p>
        </>
      )}
    </div>
  );
}
