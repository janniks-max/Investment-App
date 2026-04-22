import { useEffect, useState, useMemo } from 'react'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import type { FundamentalsRow, SectorAverage, CapRange } from '../types'

interface Props {
  onSelectTicker: (ticker: string) => void
}

const CAP_LABELS: Record<CapRange, string> = {
  all:   'All Sizes',
  small: 'Small <$2B',
  mid:   'Mid $2–10B',
  large: 'Large >$10B',
}

function matchesCap(marketCap: number | null, range: CapRange): boolean {
  if (range === 'all' || marketCap == null) return true
  if (range === 'small') return marketCap < 2e9
  if (range === 'mid')   return marketCap >= 2e9 && marketCap <= 10e9
  return marketCap > 10e9
}

function unique(arr: (string | null)[]): string[] {
  return [...new Set(arr.filter(Boolean) as string[])].sort()
}

export default function Fundamentals({ onSelectTicker }: Props) {
  const [rows,        setRows]        = useState<FundamentalsRow[]>([])
  const [sectors,     setSectors]     = useState<SectorAverage[]>([])
  const [loading,     setLoading]     = useState(true)
  const [showSectors, setShowSectors] = useState(false)

  // Fix 4: filter state
  const [fRegion,   setFRegion]   = useState('')
  const [fCountry,  setFCountry]  = useState('')
  const [fSector,   setFSector]   = useState('')
  const [fIndustry, setFIndustry] = useState('')
  const [fCap,      setFCap]      = useState<CapRange>('all')

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [f, s] = await Promise.all([
          api.getFundamentals(),
          api.getSectorAverages(),
        ])
        setRows(f)
        setSectors(s)
      } catch (e: any) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const optRegion   = useMemo(() => unique(rows.map(r => r.region)),   [rows])
  const optCountry  = useMemo(() => unique(rows.map(r => r.country)),  [rows])
  const optSector   = useMemo(() => unique(rows.map(r => r.sector)),   [rows])
  const optIndustry = useMemo(() => unique(rows.map(r => r.industry)), [rows])

  // Fix 4: AND logic across all filters
  const filtered = useMemo(() =>
    rows.filter(r =>
      (!fRegion   || r.region   === fRegion)   &&
      (!fCountry  || r.country  === fCountry)  &&
      (!fSector   || r.sector   === fSector)   &&
      (!fIndustry || r.industry === fIndustry) &&
      matchesCap(r.market_cap, fCap)
    ),
    [rows, fRegion, fCountry, fSector, fIndustry, fCap]
  )

  const hasFilters = !!(fRegion || fCountry || fSector || fIndustry || fCap !== 'all')

  function clearAll() {
    setFRegion('')
    setFCountry('')
    setFSector('')
    setFIndustry('')
    setFCap('all')
  }

  return (
    <div className="p-6 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display font-bold text-3xl text-white tracking-tight">
            Fundamentals
          </h1>
          <p className="text-sm mt-1" style={{ color: '#475569' }}>
            {filtered.length} of {rows.length} stocks · latest snapshot per ticker
          </p>
        </div>
        <button
          onClick={() => setShowSectors(v => !v)}
          className="px-4 py-2 rounded-lg text-sm transition-all"
          style={{
            background: showSectors ? 'rgba(162,89,255,0.15)' : 'var(--ink-800)',
            border: `1px solid ${showSectors ? 'rgba(162,89,255,0.3)' : 'var(--ink-600)'}`,
            color: showSectors ? 'var(--signal-purple)' : '#94a3b8',
          }}
        >
          {showSectors ? '▲ Hide' : '▼ Show'} Sector Averages
        </button>
      </div>

      {/* Sector averages — Fix 2 */}
      {showSectors && sectors.length > 0 && (
        <div className="card p-4 mb-5 overflow-x-auto">
          <p
            className="text-xs uppercase tracking-widest mb-3 font-mono"
            style={{ color: '#475569' }}
          >
            Sector Averages (latest snapshot per ticker)
          </p>
          <table className="data-table" style={{ minWidth: 780 }}>
            <thead>
              <tr>
                <th>Sector</th>
                <th>N</th>
                <th>Avg P/E</th>
                <th>Avg P/B</th>
                <th>Avg EV/EBITDA</th>
                <th>Avg ROE</th>
                <th>Avg PEG ★</th>
                <th>Avg FCF Yield ★</th>
              </tr>
            </thead>
            <tbody>
              {sectors.map(s => (
                <tr key={s.sector}>
                  <td><span className="badge badge-blue">{s.sector}</span></td>
                  <td className="font-mono text-xs" style={{ color: '#64748b' }}>{s.count}</td>
                  <td className="font-mono text-xs">{fmt.num(s.avg_pe)}</td>
                  <td className="font-mono text-xs">{fmt.num(s.avg_pb)}</td>
                  <td className="font-mono text-xs">{fmt.num(s.avg_ev_ebitda)}</td>
                  <td
                    className="font-mono text-xs"
                    style={{
                      color:
                        s.avg_roe != null && s.avg_roe > 0.15
                          ? 'var(--signal-green)'
                          : undefined,
                    }}
                  >
                    {fmt.pct(s.avg_roe)}
                  </td>
                  <td
                    className="font-mono text-xs"
                    style={{
                      color:
                        s.avg_peg != null
                          ? s.avg_peg < 1 ? 'var(--signal-green)'
                          : s.avg_peg > 2 ? 'var(--signal-red)'
                          : undefined
                          : undefined,
                    }}
                  >
                    {fmt.num(s.avg_peg)}
                  </td>
                  <td
                    className="font-mono text-xs"
                    style={{
                      color:
                        s.avg_fcf_yield != null && s.avg_fcf_yield > 0.03
                          ? 'var(--signal-green)'
                          : undefined,
                    }}
                  >
                    {s.avg_fcf_yield != null ? fmt.pct(s.avg_fcf_yield, 2) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs mt-2 font-mono" style={{ color: '#334155' }}>
            ★ Derived: PEG = pe / eps_growth_yoy · FCF Yield = free_cash_flow / market_cap
          </p>
        </div>
      )}

      {/* Fix 4: Filter bar */}
      <div
        className="flex flex-wrap gap-3 mb-4 items-end p-4 rounded-xl"
        style={{ background: 'var(--ink-800)', border: '1px solid var(--ink-600)' }}
      >
        <FilterSelect label="Region"   value={fRegion}   onChange={setFRegion}   options={optRegion} />
        <FilterSelect label="Country"  value={fCountry}  onChange={setFCountry}  options={optCountry} />
        <FilterSelect label="Sector"   value={fSector}   onChange={setFSector}   options={optSector} />
        <FilterSelect label="Industry" value={fIndustry} onChange={setFIndustry} options={optIndustry} />

        <div className="flex flex-col gap-1.5">
          <label
            className="text-xs uppercase tracking-widest font-mono"
            style={{ color: '#475569' }}
          >
            Mkt Cap
          </label>
          <select
            value={fCap}
            onChange={e => setFCap(e.target.value as CapRange)}
            className="px-3 py-1.5 rounded-lg text-sm outline-none"
            style={{
              background: 'var(--ink-700)',
              border:     '1px solid var(--ink-600)',
              color:      '#e2e8f0',
              fontFamily: 'DM Sans',
            }}
          >
            {(Object.keys(CAP_LABELS) as CapRange[]).map(k => (
              <option key={k} value={k}>{CAP_LABELS[k]}</option>
            ))}
          </select>
        </div>

        {hasFilters && (
          <button
            onClick={clearAll}
            className="px-3 py-1.5 rounded-lg text-sm transition-all self-end"
            style={{
              background: 'rgba(255,64,96,0.1)',
              border:     '1px solid rgba(255,64,96,0.25)',
              color:      'var(--signal-red)',
              fontFamily: 'DM Sans',
            }}
          >
            ✕ Clear all
          </button>
        )}

        <span
          className="text-xs font-mono self-end pb-2 ml-auto"
          style={{ color: '#334155' }}
        >
          {filtered.length} / {rows.length}
        </span>
      </div>

      {/* Main table */}
      {loading ? (
        <div className="text-center py-20" style={{ color: '#475569' }}>
          <p className="font-mono text-sm animate-pulse">Loading fundamentals…</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table" style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Name</th>
                  <th>Sector</th>
                  <th>Country</th>
                  <th>Mkt Cap</th>
                  <th>Price</th>
                  <th>P/E</th>
                  <th>P/B</th>
                  <th>EV/EBITDA</th>
                  <th>PEG ★</th>
                  <th>FCF Yield ★</th>
                  <th>ROE</th>
                  <th>D/E</th>
                  <th>Gross Mgn</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={15}
                      className="text-center py-12"
                      style={{ color: '#475569' }}
                    >
                      No stocks match your filters
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
                        className="text-xs"
                        style={{
                          color: '#94a3b8',
                          maxWidth: 140,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {row.name ?? '—'}
                      </td>
                      <td>
                        {row.sector
                          ? <span className="badge badge-blue" style={{ fontSize: 10 }}>{row.sector}</span>
                          : <span style={{ color: '#334155' }}>—</span>}
                      </td>
                      <td className="text-xs" style={{ color: '#64748b' }}>
                        {row.country ?? '—'}
                      </td>
                      <td className="font-mono text-xs" style={{ color: '#94a3b8' }}>
                        {fmt.bigNum(row.market_cap)}
                      </td>
                      <td className="font-mono text-xs">
                        {fmt.num(row.price, 2)}
                      </td>
                      <td className="font-mono text-xs">{fmt.num(row.pe)}</td>
                      <td className="font-mono text-xs">{fmt.num(row.pb)}</td>
                      <td className="font-mono text-xs">{fmt.num(row.ev_ebitda)}</td>
                      <td
                        className="font-mono text-xs"
                        style={{
                          color:
                            row.peg != null
                              ? row.peg < 1 ? 'var(--signal-green)'
                              : row.peg > 2 ? 'var(--signal-red)'
                              : undefined
                              : undefined,
                        }}
                      >
                        {fmt.num(row.peg)}
                      </td>
                      <td
                        className="font-mono text-xs"
                        style={{
                          color:
                            row.fcf_yield != null && row.fcf_yield > 0.03
                              ? 'var(--signal-green)'
                              : undefined,
                        }}
                      >
                        {row.fcf_yield != null ? fmt.pct(row.fcf_yield, 2) : '—'}
                      </td>
                      <td
                        className="font-mono text-xs"
                        style={{
                          color:
                            row.roe != null
                              ? row.roe > 0.15 ? 'var(--signal-green)'
                              : row.roe < 0    ? 'var(--signal-red)'
                              : undefined
                              : undefined,
                        }}
                      >
                        {fmt.pct(row.roe)}
                      </td>
                      <td
                        className="font-mono text-xs"
                        style={{
                          color:
                            row.debt_equity != null && row.debt_equity > 2
                              ? 'var(--signal-red)'
                              : undefined,
                        }}
                      >
                        {fmt.num(row.debt_equity)}
                      </td>
                      <td
                        className="font-mono text-xs"
                        style={{
                          color:
                            row.gross_margin != null && row.gross_margin > 0.4
                              ? 'var(--signal-green)'
                              : undefined,
                        }}
                      >
                        {fmt.pct(row.gross_margin)}
                      </td>
                      <td className="font-mono text-xs" style={{ color: '#334155' }}>
                        {fmt.timeAgo(row.fetched_at)}
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

/* ── Reusable filter select ── */
function FilterSelect({
  label, value, onChange, options,
}: {
  label:    string
  value:    string
  onChange: (v: string) => void
  options:  string[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="text-xs uppercase tracking-widest font-mono"
        style={{ color: '#475569' }}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="px-3 py-1.5 rounded-lg text-sm outline-none"
        style={{
          background: 'var(--ink-700)',
          border:     '1px solid var(--ink-600)',
          color:      '#e2e8f0',
          fontFamily: 'DM Sans',
          minWidth:   120,
        }}
      >
        <option value="">All</option>
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  )
}
