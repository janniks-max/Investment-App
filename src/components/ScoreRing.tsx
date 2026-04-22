interface Props {
  score: number
  size?: number
}

export default function ScoreRing({ score, size = 64 }: Props) {
  const r     = (size / 2) - 5
  const cx    = size / 2
  const circ  = 2 * Math.PI * r
  const fill  = circ * (score / 100)
  const gap   = circ - fill

  const color =
    score >= 65 ? 'var(--signal-green)' :
    score >= 45 ? 'var(--signal-amber)' :
                  'var(--signal-red)'

  const label =
    score >= 65 ? 'BUY'  :
    score >= 45 ? 'HOLD' :
                  'SELL'

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={cx} cy={cx} r={r}
          fill="none"
          stroke="var(--ink-600)"
          strokeWidth={4}
        />
        <circle
          cx={cx} cy={cx} r={r}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={`${fill} ${gap}`}
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
      </svg>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
        style={{ color }}
      >
        <span style={{
          fontFamily: 'JetBrains Mono',
          fontSize: size * 0.22,
          fontWeight: 600,
          lineHeight: 1,
        }}>
          {score}
        </span>
        <span style={{
          fontFamily: 'JetBrains Mono',
          fontSize: size * 0.13,
          fontWeight: 500,
          letterSpacing: '0.05em',
          opacity: 0.85,
        }}>
          {label}
        </span>
      </div>
    </div>
  )
}
