import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import type { SignalRow } from '../types'

interface Props {
  onSelectTicker: (ticker: string) => void
}

export default function Signals({ onSelectTicker }: Props) {
  const [rows,        setRows]        = useState<SignalRow[]>([])
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [total,       setTotal]       = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getSignals()
      setRows(data.rows)
      setLastUpdated(data.lastUpdated)
      setTotal(data.total)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="p-6 max-w-full">
      {/* Header — Fix 3: last updated timestamp */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display font-bold text-3xl text-white tracking-tight">
            Insider Signals
          </h1>
          <p className="text-sm mt-1" style={{ color: '#475569' }}>
            Open-market buy transactions · {total} signals
          </p>
          {lastUpdated && (
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{
                  background: 'var(--signal-green)',
                  animation: 'pulseDot 2s ease-in-out infinite',
                }}
              />
              <span
                className="text-xs font-mono"
                style={{ color: '#334155' }}
              >
                Last updated {fmt.dateTime(lastUpdated)}
                <span className="ml-2 opacity-60">({fmt.timeAgo(lastUpdated)})</span>
              </span>
            </div>
          )}
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="px-4 py-2 rounded-lg text-sm transition-all disabled:opacity-40"
          style={{
            background: 'rgba(0,229,160,0.1)',
            border:     '1px solid rgba(0,229,160,0.25)',
            color:      'var(--signal-green)',
          }}
        >
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>

      {/* Legend */}
      <div className="flex gap-3 mb-4 items-center">
        <span className="badge badge-green">Open-market buy</span>
        <span className="text-xs font-mono" style={{ color: '#334155' }}>
          Filtered: is_open_market_buy = 1
        </span>
      </div>

      {loading ? (
        <div className="text-center py-20" style={{ color: '#475569' }}>
          <p className="font-mono text-sm animate-pulse">Loading signals…</p>
        </div>
      ) : error ? (
        <div className="text-center py-20">
          <p className="font-mono text-sm mb-2" style={{ color: 'var(--signal-red)' }}>
            {error}
          </p>
          <button
            onClick={load}
            className="text-xs font-mono"
            style={{ color: '#475569' }}
          >
            retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="font-mono text-sm mb-2" style={{ color: '#475569' }}>
            No open-market buy signals found
          </p>
          <p className="text-xs" style={{ color: '#334155' }}>
            Add insider_transactions rows with is_open_market_buy = 1 to see signals here.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table" style={{ minWidth: 1000 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ticker</th>
                  <th>Company</th>
                  <th>Sector</th>
                  <th>Insider</th>
                  <th>Role</th>
                  <th>Shares</th>
                  <th>Value</th>
                  <th>Current Price</th>
                  <th>Filed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr
                    key={row.id}
                    onClick={() => onSelectTicker(row.ticker)}
                    className="cursor-pointer"
                  >
                    <td className="font-mono text-xs" style={{ color: '#94a3b8' }}>
                      {fmt.date(row.transaction_date)}
                    </td>
                    <td>
                      <span
                        className="font-mono font-semibold text-sm"
                        style={{ color: 'var(--signal-blue)' }}
                      >
                        {row.ticker}
                      </span>
                    </td>
                    <td
                      className="text-xs"
                      style={{
                        color: '#94a3b8',
                        maxWidth: 160,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {row.company_name ?? '—'}
                    </td>
                    <td>
                      {row.sector
                        ? <span className="badge badge-blue" style={{ fontSize: 10 }}>{row.sector}</span>
                        : <span style={{ color: '#334155' }}>—</span>}
                    </td>
                    <td className="text-xs" style={{ color: '#cbd5e1' }}>
                      {row.insider_name ?? '—'}
                    </td>
                    <td className="text-xs" style={{ color: '#64748b' }}>
                      {row.relation ?? '—'}
                    </td>
                    <td className="font-mono text-xs" style={{ color: 'var(--signal-green)' }}>
                      {row.shares != null ? `+${row.shares.toLocaleString()}` : '—'}
                    </td>
                    <td className="font-mono text-xs" style={{ color: 'var(--signal-green)' }}>
                      {fmt.bigNum(row.value)}
                    </td>
                    <td className="font-mono text-xs" style={{ color: '#94a3b8' }}>
                      {fmt.num(row.current_price, 2)}
                    </td>
                    <td className="font-mono text-xs" style={{ color: '#334155' }}>
                      {fmt.date(row.filed_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Table footer — Fix 3: second timestamp anchor */}
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{
              borderTop:  '1px solid var(--ink-600)',
              background: 'var(--ink-900)',
            }}
          >
            <span className="text-xs font-mono" style={{ color: '#334155' }}>
              {rows.length} open-market buy transactions shown
            </span>
            {lastUpdated && (
              <span className="text-xs font-mono" style={{ color: '#334155' }}>
                Data as of {fmt.dateTime(lastUpdated)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
