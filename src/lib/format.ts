export const fmt = {
  price: (v: number | null | undefined, currency = 'USD') =>
    v == null
      ? '—'
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(v),

  num: (v: number | null | undefined, decimals = 2) =>
    v == null
      ? '—'
      : v.toLocaleString('en-US', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }),

  pct: (v: number | null | undefined, decimals = 1) =>
    v == null ? '—' : `${(v * 100).toFixed(decimals)}%`,

  pctRaw: (v: number | null | undefined, decimals = 1) =>
    v == null ? '—' : `${v.toFixed(decimals)}%`,

  bigNum: (v: number | null | undefined) => {
    if (v == null) return '—'
    const a = Math.abs(v)
    if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
    if (a >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`
    if (a >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`
    return `$${v.toLocaleString()}`
  },

  date: (s: string | null | undefined) =>
    s == null
      ? '—'
      : new Date(s).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),

  dateTime: (s: string | null | undefined) =>
    s == null
      ? '—'
      : new Date(s).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),

  timeAgo: (s: string | null | undefined) => {
    if (!s) return '—'
    const diff = Date.now() - new Date(s).getTime()
    const mins = Math.floor(diff / 60_000)
    if (mins < 1)  return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24)  return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  },
}
