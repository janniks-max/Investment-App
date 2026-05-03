import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// ─── In-memory token (never persisted to localStorage/sessionStorage) ─────────
// Token is read from URL on mount in App.tsx, then held only in memory.
// Cleared on page refresh (intentional — user must re-enter via access link).

let _token: string | null = null;

export function getAuthToken(): string | null {
  return _token;
}

export function setAuthToken(token: string): void {
  _token = token;
}

export function clearAuthToken(): void {
  _token = null;
}

/** Build Authorization header if we have a token */
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey[0] as string}`, {
      headers: authHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // 30-second stale time so changing controls always triggers a fresh fetch
      staleTime: 30_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
