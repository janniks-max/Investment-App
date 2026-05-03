/**
 * Login page — invite-token based access
 * JWT is stored in localStorage (no cookies — Railway CDN strips Set-Cookie)
 * Supports: ?token=xxx (auto-login from invite link) OR manual paste
 */
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { setAuthToken, queryClient } from "@/lib/queryClient";

export default function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [autoTrying, setAutoTrying] = useState(false);

  // Extract token from URL query param (invite link click)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      setToken(urlToken);
      setAutoTrying(true);
      doLogin(urlToken);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginMutation = useMutation({
    mutationFn: async (inviteToken: string) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      if (!data.token) throw new Error("No JWT returned from server");
      return data as { success: boolean; token: string };
    },
    onSuccess: (data) => {
      // Store JWT in localStorage
      setAuthToken(data.token);
      // Remove token param from URL cleanly
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + (url.search || "") + (url.hash || ""));
      // Invalidate auth status so App re-checks
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
    },
    onError: (err: Error) => {
      setError(err.message);
      setAutoTrying(false);
    },
  });

  function doLogin(t: string) {
    setError("");
    loginMutation.mutate(t);
  }

  const isPending = loginMutation.isPending;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 mb-4">
            <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6 text-primary" stroke="currentColor" strokeWidth="2">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-foreground">Stock Recommender</h1>
          <p className="text-sm text-muted-foreground mt-1">Enter your invite token to access the dashboard</p>
        </div>

        {/* Login card */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-lg">
          {autoTrying && isPending ? (
            <div className="text-center py-4">
              <div className="inline-block w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mb-2" />
              <p className="text-sm text-muted-foreground">Verifying invite link…</p>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
                  {error}
                </div>
              )}
              <div className="space-y-3">
                <div>
                  <label htmlFor="token" className="block text-xs font-medium text-muted-foreground mb-1">
                    Invite Token
                  </label>
                  <input
                    id="token"
                    type="text"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && token && doLogin(token)}
                    placeholder="Paste your invite token here"
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
                    autoFocus
                  />
                </div>
                <button
                  onClick={() => token && doLogin(token)}
                  disabled={!token || isPending}
                  className="w-full bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold transition-opacity disabled:opacity-50 hover:opacity-90"
                >
                  {isPending ? "Signing in…" : "Sign In"}
                </button>
              </div>
              <p className="mt-4 text-center text-xs text-muted-foreground">
                Access is invite-only. Contact the admin for a link.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
