import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Star } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import SignalBadge from "@/components/SignalBadge";

interface EarningsEntry {
  ticker: string;
  stockName: string;
  sector: string | null;
  compositeScore: number | null;
  signal20d: string | null;
  earningsDate: string; // YYYY-MM-DD
  price: number | null;
  changePct: number | null;
  confidence20d: number | null;
  isWatchlisted: boolean;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
}

export default function Earnings() {
  const [, navigate] = useLocation();

  const { data, isLoading, error } = useQuery<EarningsEntry[]>({
    queryKey: ["/api/earnings"],
    queryFn: () => apiRequest("GET", "/api/earnings").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  // Group by date
  const grouped = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, EarningsEntry[]>();
    for (const e of data) {
      if (!map.has(e.earningsDate)) map.set(e.earningsDate, []);
      map.get(e.earningsDate)!.push(e);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({
        date,
        entries: entries.sort((a, b) => {
          // Watchlisted first, then by score
          if (a.isWatchlisted !== b.isWatchlisted) return a.isWatchlisted ? -1 : 1;
          return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
        }),
      }));
  }, [data]);

  const total = data?.length ?? 0;
  const watchlisted = data?.filter((e) => e.isWatchlisted).length ?? 0;

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))] text-sm">
        Loading earnings calendar…
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm">
        Failed to load earnings data.
      </div>
    );

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-base font-semibold text-[hsl(var(--foreground))]">Earnings Calendar</h1>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
          {total} stocks reporting in the next 30 days
          {watchlisted > 0 && (
            <span className="text-amber-400 ml-2">· {watchlisted} on your watchlist</span>
          )}
        </p>
      </div>

      {total === 0 && (
        <div className="text-sm text-[hsl(var(--muted-foreground))] italic py-8 text-center">
          No stocks with earnings dates in the next 30 days found.
          <br />
          <span className="text-xs">Run a backfill to populate earnings dates from Yahoo Finance.</span>
        </div>
      )}

      {/* Calendar groups */}
      <div className="space-y-5">
        {grouped.map(({ date, entries }) => {
          const days = daysUntil(date);
          const isToday = days === 0;
          const isTomorrow = days === 1;
          const isThisWeek = days <= 7;

          return (
            <div key={date}>
              {/* Date header */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
                  {formatDate(date)}
                </span>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded",
                  isToday ? "bg-amber-500/20 text-amber-400" :
                  isTomorrow ? "bg-blue-500/10 text-blue-400" :
                  isThisWeek ? "text-[hsl(var(--muted-foreground))] bg-secondary" :
                  "text-[hsl(var(--muted-foreground))]"
                )}>
                  {isToday ? "Today" : isTomorrow ? "Tomorrow" : `in ${days}d`}
                </span>
                <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                  {entries.length} stock{entries.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Stocks table */}
              <div className="rounded-md border border-[hsl(var(--border))] overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[hsl(var(--border))] text-[10px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--secondary))]">
                      <th className="px-3 py-1.5 text-left">Ticker</th>
                      <th className="px-3 py-1.5 text-left hidden sm:table-cell">Sector</th>
                      <th className="px-3 py-1.5 text-center">Signal</th>
                      <th className="px-3 py-1.5 text-right">Score</th>
                      <th className="px-3 py-1.5 text-right hidden sm:table-cell">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr
                        key={e.ticker}
                        data-testid={`earnings-row-${e.ticker}`}
                        onClick={() => navigate(`/stock/${e.ticker}`)}
                        className={cn(
                          "border-b border-[hsl(var(--border))] last:border-0 cursor-pointer hover:bg-[hsl(var(--secondary))]",
                          e.isWatchlisted && "bg-amber-500/5"
                        )}
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {e.isWatchlisted && (
                              <Star className="w-3 h-3 fill-amber-400 text-amber-400 flex-shrink-0" />
                            )}
                            <div>
                              <div className="font-mono font-semibold">{e.ticker}</div>
                              <div className="text-[10px] text-[hsl(var(--muted-foreground))] truncate max-w-[140px]">
                                {e.stockName}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-[hsl(var(--muted-foreground))] hidden sm:table-cell">
                          {e.sector || "—"}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {e.signal20d ? <SignalBadge signal={e.signal20d} /> : <span className="text-[hsl(var(--muted-foreground))]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {e.compositeScore != null ? e.compositeScore.toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">
                          {e.price != null ? (
                            <span>
                              ${e.price.toFixed(2)}
                              {e.changePct != null && (
                                <span className={cn("ml-1", e.changePct >= 0 ? "text-green-400" : "text-red-400")}>
                                  {e.changePct >= 0 ? "+" : ""}{e.changePct.toFixed(2)}%
                                </span>
                              )}
                            </span>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-[hsl(var(--muted-foreground))] italic">
        Earnings dates from Yahoo Finance. Dates may change. Not financial advice.
        Watchlisted stocks are highlighted with ★.
      </p>
    </div>
  );
}
