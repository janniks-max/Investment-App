import { Switch, Route, Router } from "wouter";
import { CurrencyProvider } from "./lib/currencyContext";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient, setAuthToken, getAuthToken } from "./lib/queryClient";
import { PermissionProvider, useSetPermission } from "./lib/permissionContext";
import { Toaster } from "@/components/ui/toaster";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import StockDetail from "./pages/StockDetail";
import Backtest from "./pages/Backtest";
import Universe from "./pages/Universe";
import OpportunityMap from "./pages/OpportunityMap";
import Fundamentals from "./pages/Fundamentals";
import Heatmap from "./pages/Heatmap";
import Earnings from "./pages/Earnings";
import Signals from "./pages/Signals";
import NotFound from "./pages/not-found";
import { useEffect } from "react";

/** Reads ?token= from URL on mount, stores in memory, strips from address bar */
function useUrlToken() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      setAuthToken(urlToken);
      // Strip ?token= from URL (no reload, no history entry)
      window.history.replaceState(
        {},
        "",
        window.location.pathname + window.location.hash,
      );
    }
  }, []);
}

function AuthGate({ children }: { children: React.ReactNode }) {
  useUrlToken();
  const setPermission = useSetPermission();

  // Poll /api/me to verify the in-memory token and get permission type.
  // We use /api/auth/status so we also work before /api/me was introduced.
  const { data, isLoading } = useQuery<{ type: "admin" | "viewer" } | null>({
    queryKey: ["/api/me"],
    queryFn: async () => {
      const token = getAuthToken();
      if (!token) return null;
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) return null;
      if (!res.ok) return null;
      return res.json();
    },
    retry: 1,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Propagate type into context whenever it resolves
  useEffect(() => {
    if (data?.type) setPermission(data.type);
  }, [data?.type]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data?.type) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="max-w-sm w-full mx-4 p-6 rounded-lg border border-border bg-card text-center">
          <h1 className="text-lg font-semibold mb-2">Access Required</h1>
          <p className="text-sm text-muted-foreground">
            Please use your access link to open this application.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PermissionProvider>
        <CurrencyProvider>
          <AuthGate>
            <Router hook={useHashLocation}>
              <Layout>
                <Switch>
                  <Route path="/" component={Dashboard} />
                  <Route path="/stock/:ticker" component={StockDetail} />
                  <Route path="/backtest" component={Backtest} />
                  <Route path="/universe" component={Universe} />
                  <Route path="/opportunity" component={OpportunityMap} />
                  <Route path="/fundamentals" component={Fundamentals} />
                  <Route path="/heatmap" component={Heatmap} />
                  <Route path="/earnings" component={Earnings} />
                  <Route path="/signals" component={Signals} />
                  <Route component={NotFound} />
                </Switch>
              </Layout>
            </Router>
          </AuthGate>
        </CurrencyProvider>
      </PermissionProvider>
      <Toaster />
    </QueryClientProvider>
  );
}
