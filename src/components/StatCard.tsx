interface Props {
  label: string
  value: string
  sub?:  string
  color?: string
  mono?:  boolean
}

export default function StatCard({ label, value, sub, color, mono }: Props) {
  return (
    <div className="card p-3 flex flex-col gap-1">
      <span
        className="text-xs uppercase tracking-widest"
        style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}
      >
        {label}
      </span>
      <span
        className="text-lg font-semibold leading-tight"
        style={{
          color:      color ?? '#e2e8f0',
          fontFamily: mono ? 'JetBrains Mono' : 'Syne',
        }}
      >
        {value}
      </span>
      {sub && (
        <span
          className="text-xs"
          style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}
        >
          {sub}
        </span>
      )}
    </div>
  )
}
