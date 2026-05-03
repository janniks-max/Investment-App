import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer, Cell } from "recharts";
import { Info, TrendingUp, TrendingDown, Activity, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import SignalBadge from "@/components/SignalBadge";

interface BacktestStats {
  totalRecords: number;
  byHorizon: {
    horizon: number; total: number; correct: number;
    accuracy: number; avgReturn: number; avgBenchmarkReturn: number; alpha: number;
  }[];
  bySignal: { signal: string; total: number; correct: number; accuracy: number }[];
  disclaimer: string;
}

function MetricCard({ label, value, subtext, highlight }: {
  label: string; value: string; subtext?: string; highlight?: "positive" | "negative" | "neutral";
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground mb-1">{label}</div>
        <div className={cn("text-xl font-semibold tabular-nums",
          highlight === "positive" ? "text-positive" :
          highlight === "negative" ? "text-negative" : "text-foreground"
        )}>{value}</div>
        {subtext && <div className="text-[10px] text-muted-foreground mt-0.5">{subtext}</div>}
      </CardContent>
    </Card>
  );
}

export default function Backtest() {
  const { data, isLoading } = useQuery<BacktestStats>({
    queryKey: ["/api/backtest/stats"],
    refetchInterval: 120000,
  });

  const stats = data;
  const hasSufficientData = (stats?.totalRecords ?? 0) >= 5;

  const horizonChartData = stats?.byHorizon.map((h) => ({
    name: `${h.horizon}d`,
    accuracy: h.total > 0 ? Math.round(h.accuracy) : null,
    alpha: h.total > 0 ? parseFloat(h.alpha.toFixed(2)) : null,
    count: h.total,
  })) ?? [];

  return (
    <TooltipProvider>
      <div className="p-4 space-y-4" data-testid="page-backtest">
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-base font-semibold text-foreground">Backtest & Evaluation</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Historical accuracy of model signals. Evaluated once exit prices become available.
            </p>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="w-4 h-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                Signals are recorded each time data refreshes. After the horizon period, actual returns are compared.
                This requires the app to run continuously. Past accuracy does not predict future results.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Disclaimer */}
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <strong className="text-amber-500">Research evaluation only.</strong>{" "}
            {stats?.disclaimer ?? "Model outputs are probabilistic estimates. Past accuracy does not guarantee future performance."}
            Backtest results are available only after sufficient time has passed for exits to be evaluated.
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard
            label="Total Signals"
            value={isLoading ? "—" : String(stats?.totalRecords ?? 0)}
            subtext="Recorded since launch"
          />
          <MetricCard
            label="Evaluated"
            value={isLoading ? "—" : String(stats?.byHorizon.reduce((a, b) => a + b.total, 0) ?? 0)}
            subtext="With known outcomes"
          />
          <MetricCard
            label="Best Accuracy"
            value={isLoading ? "—" : (hasSufficientData ? Math.round(Math.max(...stats!.byHorizon.map((h) => h.accuracy))) + "%" : "Pending")}
            subtext="Across horizons"
            highlight={hasSufficientData ? "positive" : "neutral"}
          />
          <MetricCard
            label="Best Alpha"
            value={isLoading ? "—" : (hasSufficientData ? stats!.byHorizon.reduce((a, b) => a.alpha > b.alpha ? a : b).alpha.toFixed(1) + "%" : "Pending")}
            subtext="vs. benchmark (SPY)"
            highlight={hasSufficientData ? "positive" : "neutral"}
          />
        </div>

        {!hasSufficientData && !isLoading && (
          <div className="rounded-md border border-border bg-card p-6 text-center text-muted-foreground">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <div className="text-sm font-medium text-foreground mb-1">Backtest data accumulating</div>
            <div className="text-xs max-w-md mx-auto">
              Backtest results appear after the app has been running long enough for signals to be evaluated.
              Keep the app running with auto-refresh enabled. Currently {stats?.totalRecords ?? 0} record(s) stored.
            </div>
          </div>
        )}

        {hasSufficientData && (
          <>
            {/* Accuracy by horizon */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="bg-card border-border">
                <CardHeader className="p-3 pb-2 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Signal Accuracy by Horizon</CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={horizonChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <ReTooltip
                          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                          formatter={(v: any) => [v + "%", "Accuracy"]}
                        />
                        <Bar dataKey="accuracy" radius={[4, 4, 0, 0]}>
                          {horizonChartData.map((_, i) => (
                            <Cell key={i} fill={`hsl(${174 + i * 10} 60% ${35 + i * 5}%)`} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader className="p-3 pb-2 border-b border-border">
                  <CardTitle className="text-sm font-semibold">Alpha vs Benchmark (SPY)</CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={horizonChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <ReTooltip
                          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                          formatter={(v: any) => [v + "%", "Alpha"]}
                        />
                        <Bar dataKey="alpha" radius={[4, 4, 0, 0]}>
                          {horizonChartData.map((entry, i) => (
                            <Cell key={i} fill={(entry.alpha ?? 0) >= 0 ? "hsl(142 60% 42%)" : "hsl(0 62% 52%)"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Detailed table */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold">Horizon Detail Table</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-[10px] text-muted-foreground">
                        <th className="px-3 py-2 text-left">Horizon</th>
                        <th className="px-3 py-2 text-right">Signals</th>
                        <th className="px-3 py-2 text-right">Correct</th>
                        <th className="px-3 py-2 text-right">Accuracy</th>
                        <th className="px-3 py-2 text-right">Avg Return</th>
                        <th className="px-3 py-2 text-right">Benchmark</th>
                        <th className="px-3 py-2 text-right">Alpha</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats?.byHorizon.map((h) => (
                        <tr key={h.horizon} className="border-b border-border last:border-0 hover:bg-secondary/50">
                          <td className="px-3 py-2 font-medium">{h.horizon}d</td>
                          <td className="px-3 py-2 text-right tabular-nums">{h.total}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{h.correct}</td>
                          <td className={cn("px-3 py-2 text-right tabular-nums font-medium",
                            h.total === 0 ? "text-muted-foreground" :
                            h.accuracy >= 55 ? "text-positive" : "text-negative"
                          )}>
                            {h.total > 0 ? Math.round(h.accuracy) + "%" : "—"}
                          </td>
                          <td className={cn("px-3 py-2 text-right tabular-nums",
                            h.avgReturn >= 0 ? "text-positive" : "text-negative"
                          )}>
                            {h.total > 0 ? (h.avgReturn >= 0 ? "+" : "") + h.avgReturn.toFixed(1) + "%" : "—"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {h.total > 0 ? (h.avgBenchmarkReturn >= 0 ? "+" : "") + h.avgBenchmarkReturn.toFixed(1) + "%" : "—"}
                          </td>
                          <td className={cn("px-3 py-2 text-right tabular-nums font-medium",
                            h.total === 0 ? "text-muted-foreground" :
                            h.alpha >= 0 ? "text-positive" : "text-negative"
                          )}>
                            {h.total > 0 ? (h.alpha >= 0 ? "+" : "") + h.alpha.toFixed(1) + "%" : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* By signal type */}
            <Card className="bg-card border-border">
              <CardHeader className="p-3 pb-2 border-b border-border">
                <CardTitle className="text-sm font-semibold">Accuracy by Signal Type</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="grid grid-cols-3 gap-3">
                  {stats?.bySignal.map(({ signal, total, correct, accuracy }) => (
                    <div key={signal} className="bg-secondary rounded-md p-3 text-center">
                      <SignalBadge signal={signal} size="md" />
                      <div className="mt-2 text-lg font-semibold tabular-nums text-foreground">
                        {total > 0 ? Math.round(accuracy) + "%" : "—"}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {correct}/{total} correct
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </>
        )}

        <div className="rounded-md border border-border bg-card/50 p-3 text-[10px] text-muted-foreground">
          <strong>Methodology:</strong> A signal is "correct" if, after the horizon period, the stock outperformed the SPY benchmark.
          Alpha = average return minus average benchmark return. All prices from Yahoo Finance.
          Benchmark: SPY. Missing exit prices = "pending". Pending records excluded from accuracy calculation.
        </div>
      </div>
    </TooltipProvider>
  );
}
