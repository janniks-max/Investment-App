import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import type { UniverseRow } from '../types'

interface Props {
  onSelectTicker: (ticker: string) => void
}

export default function Dashboard({ onSelectTicker }: Props) {
  const [universe, setUniverse]   = useState<UniverseRow[]>([])
  const [loading,  setLoading]    = useState(true)
  const [error,    setError]      = useState<string | null>(null)
  const [search,   setSearch]     = useState('')
  const [addInput, setAddInput]   = useState('')
  const [adding,   setAdding]     = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const rows = await api.getUniverse()
      setUniverse(rows)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAdd() {
    const ticker = addInput.trim().toUpperCase()
    if (!ticker) return
    setAdding(true)
    try {
      await api.addTicker({ ticker })
      setAddInput('')
      await load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setAdding(false)
    }
  }

  const filtered = universe.filter(u =>
    u.ticker.toLowerCase().includes(search.toLowerCase()) ||
    (u.name     ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (u.sector   ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (u.industry ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8 stagger">
        <h1 className="font-display font-bold text-3xl text-white tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm mt-1" style={{ color: '#475569' }}>
          {universe.length} stocks tracked · click any row to view details
        </p>
      </div>

      {/* Controls */}
      <div className="flex gap-3 mb-6">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search ticker, name, sector…"
          className="flex-1 px-4 py-2.5 rounded-lg text-sm outline-none"
          style={{
            background: 'var(--ink-800)',
            border:     '1px solid var(--ink-600)',
            color:      '#e2e8f0',
            fontFamily: 'DM Sans',
          }}
        />
        <input
          value={addInput}
          onChange={e => setAddInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="AAPL"
          maxLength={10}
          className="px-4 py-2.5 rounded-lg text-sm outline-none w-28"
          style={{
            background: 'var(--ink-800)',
            border:     '1px solid var(--ink-600)',
            color:      '#e2e8f0',
            fontFamily: 'JetBrains Mono',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={adding || !addInput.trim()}
          className="px-4 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
          style={{
            background: 'rgba(61,142,255,0.15)',
            border:     '1px solid rgba(61,142,255,0.3)',
            color:      'var(--signal-blue)',
          }}
        >
          {adding ? '…' : '+ Add'}
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-20" style={{ color: '#475569' }}>
          <p className="font-mono text-sm animate-pulse">Loading universe…</p>
        </div>
      ) : error ? (
        <div className="text-center py-20">
          <p className="font-mono text-sm" style={{ color: 'var(--signal-red)' }}>{error}</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Name</th>
                  <th>Sector</th>
                  <th>Industry</th>
                  <th>Region</th>
                  <th>Mkt Cap</th>
                  <th>Exchange</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="text-center py-12"
                      style={{ color: '#475569' }}
                    >
                      {search
                        ? 'No results — try a different search'
                        : 'No stocks yet — add a ticker above'}
                    </td>
                  </tr>
                ) : (
                  filtered.map(row => (
                    <tr
                      key={row.ticker}
                      onClick={() => onSelectTicker(row.ticker)}
                      className="cursor-pointer"
                    >
                      <td>
                        <span
                          className="font-mono font-semibold text-sm"
                          style={{ color: 'var(--signal-blue)' }}
                        >
                          {row.ticker}
                        </span>
                      </td>
                      <td
                        className="text-sm"
                        style={{
                          color: '#cbd5e1',
                          maxWidth: 180,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {row.name ?? '—'}
                      </td>
                      <td>
                        {row.sector
                          ? <span className="badge badge-blue">{row.sector}</span>
                          : <span style={{ color: '#334155' }}>—</span>}
                      </td>
                      <td className="text-xs" style={{ color: '#64748b' }}>
                        {row.industry ?? '—'}
                      </td>
                      <td className="text-xs" style={{ color: '#64748b' }}>
                        {row.region ?? '—'}
                      </td>
                      <td className="font-mono text-xs" style={{ color: '#94a3b8' }}>
                        {fmt.bigNum(row.market_cap)}
                      </td>
                      <td className="text-xs" style={{ color: '#64748b' }}>
                        {row.exchange ?? '—'}
                      </td>
                      <td>
                        <span className={`badge ${row.is_active ? 'badge-green' : 'badge-gray'}`}>
                          {row.is_active ? 'active' : 'inactive'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
