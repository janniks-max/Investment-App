import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import { computeScore, pctFromHigh } from '../lib/momentum'
import type { Snapshot, UniverseRow } from '../types'
import ScoreRing    from '../components/ScoreRing'
import MomentumCard from '../components/MomentumCard'
import StatCard     from '../components/StatCard'

interface Props {
  ticker: string
  onBack: () => void
}

type Tab = 'overview' | 'fundamentals' | 'technicals'

export default function StockDetail({ ticker, onBack }: Props) {
  const [info,     setInfo]     = useState<UniverseRow | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [tab,      setTab]      = useState<Tab>('overview')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getStock(ticker)
      setInfo(data.info)
      setSnapshot(data.snapshot)
    } catch (e: any) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [ticker])

  useEffect(() => { load() }, [load])

  // Fix 1: Fetch live data and reload
  async function handleFetch() {
    setFetching(true)
    setFetchErr(null)
    try {
      await api.fetchStock(ticker)
      const full = await api.getStock(ticker)
      setInfo(full.info)
      setSnapshot(full.snapshot)
    } catch (e: any) {
      setFetchErr(e.message)
    } finally {
      setFetching(false)
    }
  }

  const score    = snapshot ? computeScore(snapshot) : null
  const fromHigh = snapshot ? pctFromHigh(snapshot.price, snapshot.high_52w) : null
  const currency = info?.currency ?? 'USD'

  const priceColor =
    fromHigh == null  ? '#e2e8f0' :
    fromHigh >= -5    ? 'var(--signal-green)' :
    fromHigh <= -30   ? 'var(--signal-red)'   : '#e2e8f0'

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview',     label: 'Overview' },
    { id: 'fundamentals', label: 'Fundamentals' },
    { id: 'technicals',   label: 'Technicals' },
  ]

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm mb-5 transition-colors"
        style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}
      >
        ← Back to Dashboard
      </button>

      {loading ? (
        <div className="text-center py-20" style={{ color: '#475569' }}>
          <p className="font-mono text-sm animate-pulse">Loading {ticker}…</p>
        </div>
      ) : (
        <div className="stagger">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 mb-6">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <h1 className="font-display font-bold text-3xl text-white">{ticker}</h1>
                {info?.exchange && (
                  <span className="badge badge-gray">{info.exchange}</span>
                )}
                {info?.sector && (
                  <span className="badge badge-blue">{info.sector}</span>
                )}
              </div>
              <p className="text-sm" style={{ color: '#64748b' }}>
                {info?.name ?? ticker}
              </p>
              {info?.industry && (
                <p
                  className="text-xs mt-0.5"
                  style={{ color: '#334155', fontFamily: 'JetBrains Mono' }}
                >
                  {info.industry}
                </p>
              )}
            </div>

            {score !== null && (
              <div className="flex flex-col items-center gap-1">
                <ScoreRing score={score} size={72} />
                <span
                  className="text-xs font-mono"
                  style={{ color: '#475569' }}
                >
                  rec. score
                </span>
              </div>
            )}
          </div>

          {/* Price bar + Fetch button — Fix 1 */}
          <div className="card p-4 mb-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              {snapshot?.price != null ? (
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span
                    className="font-display font-bold text-4xl"
                    style={{ color: priceColor }}
                  >
                    {fmt.price(snapshot.price, currency)}
                  </span>
                  {fromHigh !== null && (
                    <span
                      className="text-sm font-mono"
                      style={{
                        color: fromHigh < 0
                          ? 'var(--signal-red)'
                          : 'var(--signal-green)',
                      }}
                    >
                      {fromHigh >= 0 ? '+' : ''}{fromHigh.toFixed(1)}% vs 52w high
                    </span>
                  )}
                </div>
              ) : (
                <span
                  className="font-display text-2xl"
                  style={{ color: '#475569' }}
                >
                  No data yet
                </span>
              )}
              {snapshot?.fetched_at && (
                <p
                  className="text-xs mt-1 font-mono"
                  style={{ color: '#334155' }}
                >
                  Last fetched {fmt.timeAgo(snapshot.fetched_at)} ·{' '}
                  {fmt.dateTime(snapshot.fetched_at)}
                </p>
              )}
            </div>

            {/* Fix 1: Fetch Data button */}
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={handleFetch}
                disabled={fetching}
                className="px-5 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40 flex items-center gap-2"
                style={{
                  background: 'rgba(61,142,255,0.15)',
                  border:     '1px solid rgba(61,142,255,0.3)',
                  color:      'var(--signal-blue)',
                  fontFamily: 'DM Sans',
                }}
              >
                {fetching ? '◈ Fetching…' : '↻ Fetch Live Data'}
              </button>
              {fetchErr && (
                <p
                  className="text-xs font-mono"
                  style={{ color: 'var(--signal-red)' }}
                >
                  {fetchErr}
                </p>
              )}
            </div>
          </div>

          {/* Feature 6: Momentum card */}
          {snapshot && (snapshot.high_52w != null || snapshot.low_52w != null) && (
            <div className="mb-4">
              <MomentumCard
                price={snapshot.price}
                high52w={snapshot.high_52w}
                low52w={snapshot.low_52w}
                currency={currency}
              />
            </div>
          )}

          {/* Tabs */}
          <div
            className="flex gap-1 mb-4 p-1 rounded-lg w-fit"
            style={{
              background: 'var(--ink-800)',
              border:     '1px solid var(--ink-600)',
            }}
          >
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="px-4 py-1.5 rounded-md text-sm transition-all"
                style={{
                  background: tab === t.id ? 'var(--ink-600)' : 'transparent',
                  color:      tab === t.id ? '#e2e8f0' : '#64748b',
                  fontFamily: 'DM Sans',
                  fontWeight: tab === t.id ? 500 : 400,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {!snapshot ? (
            <div className="card p-10 text-center">
              <p
                className="font-mono text-sm mb-4"
                style={{ color: '#475569' }}
              >
                No snapshot data for {ticker}.
                Click "Fetch Live Data" to load from Yahoo Finance.
              </p>
            </div>
          ) : tab === 'overview' ? (
            <OverviewTab snapshot={snapshot} info={info} currency={currency} />
          ) : tab === 'fundamentals' ? (
            <FundamentalsTab snapshot={snapshot} />
          ) : (
            <TechnicalsTab snapshot={snapshot} />
          )}
        </div>
      )}
    </div>
  )
}

/* ── Overview tab ── */
function OverviewTab({
  snapshot: s,
  info,
  currency,
}: {
  snapshot: Snapshot
  info: UniverseRow | null
  currency: string
}) {
  const total    = (s.analyst_buy ?? 0) + (s.analyst_hold ?? 0) + (s.analyst_sell ?? 0)
  const buyPct   = total > 0 ? ((s.analyst_buy ?? 0) / total) * 100 : null
  const holdPct  = total > 0 ? ((s.analyst_hold ?? 0) / total) * 100 : null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="P/E"            value={fmt.num(s.pe)}              mono />
        <StatCard label="P/B"            value={fmt.num(s.pb)}              mono />
        <StatCard label="P/S"            value={fmt.num(s.ps)}              mono />
        <StatCard label="EV/EBITDA"      value={fmt.num(s.ev_ebitda)}       mono />
        <StatCard label="EPS"            value={fmt.num(s.eps)}             mono />
        <StatCard
          label="EPS Growth YoY"
          value={fmt.pct(s.eps_growth_yoy)}
          mono
          color={
            s.eps_growth_yoy != null
              ? s.eps_growth_yoy > 0 ? 'var(--signal-green)' : 'var(--signal-red)'
              : undefined
          }
        />
        <StatCard
          label="Rev Growth YoY"
          value={fmt.pct(s.revenue_growth_yoy)}
          mono
          color={
            s.revenue_growth_yoy != null
              ? s.revenue_growth_yoy > 0 ? 'var(--signal-green)' : 'var(--signal-red)'
              : undefined
          }
        />
        <StatCard label="Beta" value={fmt.num(s.beta)} mono />
      </div>

      {/* Analyst consensus */}
      {total > 0 && (
        <div className="card p-4">
          <p
            className="text-xs uppercase tracking-widest mb-3"
            style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}
          >
            Analyst Consensus · {total} analysts
          </p>
          <div className="flex gap-4 mb-3 items-center flex-wrap">
            <span className="badge badge-green">{s.analyst_buy ?? 0} Buy</span>
            <span className="badge badge-gray">{s.analyst_hold ?? 0} Hold</span>
            <span className="badge badge-red">{s.analyst_sell ?? 0} Sell</span>
            {s.price_target != null && (
              <span
                className="ml-auto text-sm font-mono"
                style={{ color: '#94a3b8' }}
              >
                PT {fmt.price(s.price_target, currency)}
              </span>
            )}
          </div>
          {buyPct !== null && (
            <div className="flex gap-0.5 h-2 rounded-full overflow-hidden">
              <div style={{ width: `${buyPct}%`, background: 'var(--signal-green)' }} />
              <div style={{ width: `${holdPct}%`, background: '#334155' }} />
              <div style={{ flex: 1, background: 'var(--signal-red)' }} />
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Next Earnings"  value={fmt.date(s.earnings_date)} />
        <StatCard label="Dividend Yield" value={fmt.pct(s.dividend_yield)} mono />
        <StatCard label="Short % Float"  value={fmt.pct(s.short_percent_of_float)} mono />
        <StatCard label="Free Cash Flow" value={fmt.bigNum(s.free_cash_flow)} mono />
      </div>

      {info && (
        <div className="card p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Country',    value: info.country },
            { label: 'Region',     value: info.region },
            { label: 'Currency',   value: info.currency },
            { label: 'Asset Type', value: info.asset_type },
          ].map(({ label, value }) => (
            <div key={label}>
              <p
                className="text-xs uppercase tracking-widest mb-1"
                style={{ color: '#334155', fontFamily: 'JetBrains Mono' }}
              >
                {label}
              </p>
              <p style={{ color: '#94a3b8' }}>{value ?? '—'}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Fundamentals tab ── */
function FundamentalsTab({ snapshot: s }: { snapshot: Snapshot }) {
  const peg =
    s.pe != null && (s.eps_growth_yoy ?? 0) > 0
      ? s.pe / s.eps_growth_yoy!
      : null

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <StatCard
        label="Gross Margin"
        value={fmt.pct(s.gross_margin)}
        mono
        color={s.gross_margin != null && s.gross_margin > 0.4 ? 'var(--signal-green)' : undefined}
      />
      <StatCard
        label="Operating Margin"
        value={fmt.pct(s.operating_margin)}
        mono
        color={
          s.operating_margin != null
            ? s.operating_margin > 0.15 ? 'var(--signal-green)'
            : s.operating_margin < 0    ? 'var(--signal-red)'
            : undefined
            : undefined
        }
      />
      <StatCard
        label="ROE"
        value={fmt.pct(s.roe)}
        mono
        color={
          s.roe != null
            ? s.roe > 0.15 ? 'var(--signal-green)'
            : s.roe < 0    ? 'var(--signal-red)'
            : undefined
            : undefined
        }
      />
      <StatCard
        label="Debt / Equity"
        value={fmt.num(s.debt_equity)}
        mono
        color={
          s.debt_equity != null
            ? s.debt_equity > 2   ? 'var(--signal-red)'
            : s.debt_equity < 0.5 ? 'var(--signal-green)'
            : undefined
            : undefined
        }
      />
      <StatCard
        label="PEG Ratio"
        value={fmt.num(peg)}
        mono
        color={
          peg != null
            ? peg < 1  ? 'var(--signal-green)'
            : peg > 2  ? 'var(--signal-red)'
            : undefined
            : undefined
        }
      />
      <StatCard label="P/E"       value={fmt.num(s.pe)}       mono />
      <StatCard label="P/B"       value={fmt.num(s.pb)}       mono />
      <StatCard label="EV/EBITDA" value={fmt.num(s.ev_ebitda)} mono />
      <StatCard label="EPS"       value={fmt.num(s.eps)}       mono />
    </div>
  )
}

/* ── Technicals tab ── */
function TechnicalsTab({ snapshot: s }: { snapshot: Snapshot }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <StatCard
        label="Beta"
        value={fmt.num(s.beta)}
        mono
        color={
          s.beta != null && s.beta > 1.5 ? 'var(--signal-amber)' : undefined
        }
      />
      <StatCard label="52W High"  value={fmt.num(s.high_52w, 2)} mono />
      <StatCard label="52W Low"   value={fmt.num(s.low_52w,  2)} mono />
      <StatCard
        label="Short % Float"
        value={fmt.pct(s.short_percent_of_float)}
        mono
        color={
          s.short_percent_of_float != null && s.short_percent_of_float > 0.1
            ? 'var(--signal-amber)'
            : undefined
        }
      />
    </div>
  )
}
