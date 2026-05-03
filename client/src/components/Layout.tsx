import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useCurrency } from "@/lib/currencyContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, clearAuthToken } from "@/lib/queryClient";
import {
  BarChart2, Globe, BookOpen, RefreshCw, Sun, Moon,
  ChevronLeft, ChevronRight, Activity, TrendingUp, Clock, AlertTriangle, Map, LogOut, LayoutGrid, CalendarDays, Zap
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface StatusData {
  scheduler: { running: boolean; intervalMinutes: number; isRefreshing: boolean; anyMarketOpen: boolean };
  lastRefresh: {
    completedAt?: string; completed_at?: string;
    tickersSucceeded?: number; tickers_succeeded?: number;
    tickersFailed?: number; tickers_failed?: number;
  } | null;
  currentInterval: number;
}

interface RefreshProgress {
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

const NAV_ITEMS = [
  { path: "/", label: "Momentum", icon: BarChart2 },
  { path: "/fundamentals", label: "Fundamentals", icon: TrendingUp },
  { path: "/heatmap", label: "Heatmap", icon: LayoutGrid },
  { path: "/earnings", label: "Earnings", icon: CalendarDays },
  { path: "/signals", label: "Signals", icon: Zap },
  { path: "/universe", label: "Universe", icon: Globe },
  { path: "/backtest", label: "Backtest", icon: BookOpen },
  { path: "/opportunity", label: "Opportunity Map", icon: Map },
];

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "Never";
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { displayCurrency, setDisplayCurrency } = useCurrency();

  // Dark mode
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("light", !isDark);
  }, [isDark]);

  // Default dark on mount
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  const { data: status } = useQuery<StatusData>({
    queryKey: ["/api/status"],
    refetchInterval: 30000,
  });

  const { data: progress } = useQuery<RefreshProgress>({
    queryKey: ["/api/refresh/progress"],
    refetchInterval: (data) => data?.isRefreshing ? 2000 : 30000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/refresh"),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/recommendations"] });
      qc.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Refresh complete",
        description: `Succeeded: ${data.succeeded}, Failed: ${data.failed}`,
      });
    },
    onError: () => {
      toast({ title: "Refresh failed", variant: "destructive" });
    },
  });

  const marketOpen = status?.scheduler?.anyMarketOpen;
  const isRefreshing = status?.scheduler?.isRefreshing || refreshMutation.isPending;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col border-r border-border bg-card transition-all duration-200 overflow-y-auto overscroll-contain",
          collapsed ? "w-14" : "w-52"
        )}
        data-testid="sidebar"
      >
        {/* Logo */}
        <div className={cn("flex items-center gap-2 px-3 py-4 border-b border-border min-h-[56px]", collapsed && "justify-center px-0")}>
          <svg viewBox="0 0 28 28" fill="none" className="w-7 h-7 flex-shrink-0" aria-label="Stock Recommender Logo">
            <rect width="28" height="28" rx="6" fill="hsl(var(--primary))" />
            <polyline points="4,20 9,13 13,16 19,8 24,11" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="11" r="1.8" fill="white" />
          </svg>
          {!collapsed && (
            <div className="overflow-hidden">
              <div className="text-sm font-semibold text-foreground leading-tight">Stock</div>
              <div className="text-[10px] text-muted-foreground leading-tight tracking-wide uppercase">Recommender</div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 px-2 space-y-0.5">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <Link key={path} href={path}>
              <a
                className={cn(
                  "flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-colors",
                  location === path
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                  collapsed && "justify-center px-0 gap-0"
                )}
                data-testid={`nav-${label.toLowerCase()}`}
                title={collapsed ? label : undefined}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span>{label}</span>}
              </a>
            </Link>
          ))}
        </nav>

        {/* Market Status */}
        {!collapsed && (
          <div className="px-3 py-2 border-t border-border">
            <div className="flex items-center gap-2 mb-1.5">
              <div className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", marketOpen ? "bg-green-500 animate-pulse" : "bg-muted-foreground")} />
              <span className="text-xs text-muted-foreground">{marketOpen ? "Market open" : "Market closed"}</span>
            </div>
            {status?.lastRefresh && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>Refreshed {formatRelativeTime(status.lastRefresh.completedAt ?? status.lastRefresh.completed_at ?? null)}</span>
              </div>
            )}
          </div>
        )}

        {/* Sign out + collapse toggle */}
        <div className="border-t border-border">
          <button
            onClick={async () => {
              clearAuthToken();
              await apiRequest("POST", "/api/auth/logout").catch(() => {});
              window.location.reload();
            }}
            className={cn("w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors", collapsed && "justify-center px-0")}
            title="Sign Out"
          >
            <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
            {!collapsed && <span>Sign Out</span>}
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn("w-full flex items-center justify-center p-3 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors")}
            data-testid="sidebar-collapse"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top header */}
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card min-h-[56px] flex-shrink-0" data-testid="header">
          {/* Left: breadcrumb */}
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground">
              {NAV_ITEMS.find((n) => n.path === location)?.label ?? "Stock Recommender"}
            </span>
            {status?.scheduler?.running && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-primary border-primary/30">
                Auto-refresh {status.currentInterval}m
              </Badge>
            )}
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-2">
            {/* Data freshness */}
            {status?.lastRefresh && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity className="w-3.5 h-3.5" />
                <span className="tabular-nums">{status.lastRefresh.tickersSucceeded ?? status.lastRefresh.tickers_succeeded ?? 0} stocks updated</span>
                {(status.lastRefresh.tickersFailed ?? status.lastRefresh.tickers_failed ?? 0) > 0 && (
                  <span className="text-amber-500 flex items-center gap-0.5">
                    <AlertTriangle className="w-3 h-3" />
                    {status.lastRefresh.tickersFailed ?? status.lastRefresh.tickers_failed} failed
                  </span>
                )}
              </div>
            )}

            {/* Refresh button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={isRefreshing}
              className="h-7 gap-1.5 text-xs"
              data-testid="button-refresh"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin")} />
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>

            {/* EUR / USD toggle */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
              <button
                onClick={() => setDisplayCurrency("EUR")}
                className={cn(
                  "px-2 py-1 transition-colors",
                  displayCurrency === "EUR"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                )}
                data-testid="button-currency-eur"
                aria-label="Display in EUR"
              >
                € EUR
              </button>
              <button
                onClick={() => setDisplayCurrency("USD")}
                className={cn(
                  "px-2 py-1 transition-colors border-l border-border",
                  displayCurrency === "USD"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                )}
                data-testid="button-currency-usd"
                aria-label="Display in USD"
              >
                $ USD
              </button>
            </div>

            {/* Theme toggle */}
            <button
              onClick={() => setIsDark(!isDark)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              data-testid="button-theme"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Refresh progress bar */}
        {progress?.isRefreshing && (
          <div className="h-1 bg-secondary flex-shrink-0">
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: progress.total > 0 ? `${Math.round((progress.fetched / progress.total) * 100)}%` : "5%" }}
            />
          </div>
        )}
        {progress?.isRefreshing && (
          <div className="px-4 py-1.5 border-b border-border bg-primary/5 flex-shrink-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="w-3 h-3 animate-spin text-primary" />
              <span className="text-primary font-medium capitalize">{progress.phase}</span>
              {progress.total > 0 && (
                <span>{progress.fetched} / {progress.total} stocks</span>
              )}
              {progress.totalBatches > 0 && (
                <span>· batch {progress.currentBatch}/{progress.totalBatches}</span>
              )}
              {progress.estimatedSecondsRemaining != null && progress.estimatedSecondsRemaining > 0 && (
                <span>· ~{progress.estimatedSecondsRemaining}s remaining</span>
              )}
            </div>
          </div>
        )}

        {/* Page content */}
        <main className="flex-1 overflow-y-auto overscroll-contain" data-testid="main-content">
          {children}
        </main>

        {/* Disclaimer footer */}
        <div className="px-4 py-1.5 border-t border-border bg-card flex-shrink-0">
          <p className="text-[10px] text-muted-foreground text-center">
            ⚠ Research tool only — not financial advice. Model outputs are probabilistic estimates. Data via Yahoo Finance / Alpha Vantage (15-min delayed or EOD).
          </p>
        </div>
      </div>
    </div>
  );
}
