import type { FundamentalsRow, SignalRow, SectorAverage, UniverseRow, Snapshot } from '../types'

async function req<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as any).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  getStock: (ticker: string) =>
    req<{ info: UniverseRow | null; snapshot: Snapshot | null }>(`/api/stock/${ticker}`),

  fetchStock: (ticker: string) =>
    req<{ success: boolean; fetched_at: string; snapshot: Snapshot }>(
      `/api/stock/${ticker}/fetch`,
      { method: 'POST' }
    ),

  getHistory: (ticker: string) =>
    req<Snapshot[]>(`/api/stock/${ticker}/history`),

  getUniverse: () =>
    req<UniverseRow[]>('/api/universe'),

  addTicker: (body: Partial<UniverseRow> & { ticker: string }) =>
    req<{ success: boolean }>('/api/universe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getFundamentals: () =>
    req<FundamentalsRow[]>('/api/fundamentals'),

  getSectorAverages: () =>
    req<SectorAverage[]>('/api/sector-averages'),

  getSignals: () =>
    req<{ rows: SignalRow[]; lastUpdated: string; total: number }>('/api/signals'),
}
