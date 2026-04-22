import { pctFromHigh, pctFromLow, getMomentumFlag } from '../lib/momentum'
import { fmt } from '../lib/format'

interface Props {
  price:     number | null
  high52w:   number | null
  low52w:    number | null
  currency?: string
}

export default function MomentumCard({ price, high52w, low52w, currency = 'USD' }: Props) {
  const fromHigh = pctFromHigh(price, high52w)
  const fromLow  = pctFromLow(price, low52w)
  const flag     = getMomentumFlag(fromHigh)

  const rangePercent =
    high52w && low52w && price && high52w !== low52w
      ? Math.min(100, Math.max(0, ((price - low52w) / (high52w - low52w)) * 100))
      : null

  const styles = {
    near_high: {
      border: '1px solid rgba(0,229,160,0.3)',
      bg:     'rgba(0,229,160,0.05)',
      color:  'var(--signal-green)',
      icon:   '↑',
      label:  'Near 52-week high — momentum boost applied (+5 pts)',
    },
    deep_drawdown: {
      border: '1px solid rgba(255,64,96,0.3)',
      bg:     'rgba(255,64,96,0.05)',
      color:  'var(--signal-red)',
      icon:   '↓',
      label:  '>30% below 52-week high — momentum flag (−10 pts)',
    },
    neutral: {
      border: '1px solid var(--ink-600)',
      bg:     'transparent',
      color:  '#94a3b8',
      icon:   '↔',
      label:  'Mid-range — no momentum adjustment',
    },
  }

  const s = styles[flag]

  return (
    <div className="rounded-xl p-4" style={{ background: s.bg, border: s.border }}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className="text-xs uppercase tracking-widest"
          style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}
        >
          52-Week Momentum
        </span>
        <span style={{ color: s.color, fontFamily: 'JetBrains Mono' }}>{s.icon}</span>
      </div>

      {/* Price row */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <div>
          <p className="text-xs mb-1" style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}>
            52W LOW
          </p>
          <p className="font-mono text-sm font-medium" style={{ color: '#94a3b8' }}>
            {fmt.price(low52w, currency)}
          </p>
        </div>
        <div>
          <p className="text-xs mb-1" style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}>
            CURRENT
          </p>
          <p className="font-display font-bold text-base" style={{ color: '#e2e8f0' }}>
            {fmt.price(price, currency)}
          </p>
        </div>
        <div>
          <p className="text-xs mb-1" style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}>
            52W HIGH
          </p>
          <p className="font-mono text-sm font-medium" style={{ color: '#94a3b8' }}>
            {fmt.price(high52w, currency)}
          </p>
        </div>
      </div>

      {/* Range bar */}
      {rangePercent !== null && (
        <div className="mb-3">
          <div
            className="w-full h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--ink-600)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${rangePercent}%`, background: s.color }}
            />
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex justify-between items-center mb-2">
        <div className="flex gap-4">
          {fromHigh !== null && (
            <span
              className="text-xs font-mono"
              style={{ color: fromHigh < 0 ? 'var(--signal-red)' : 'var(--signal-green)' }}
            >
              {fromHigh >= 0 ? '+' : ''}{fromHigh.toFixed(1)}% vs high
            </span>
          )}
          {fromLow !== null && (
            <span className="text-xs font-mono" style={{ color: 'var(--signal-green)' }}>
              +{fromLow.toFixed(1)}% vs low
            </span>
          )}
        </div>
      </div>

      {/* Flag label */}
      <p className="text-xs font-mono" style={{ color: '#475569' }}>{s.label}</p>
    </div>
  )
}
