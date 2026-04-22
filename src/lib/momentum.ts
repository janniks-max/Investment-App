export type MomentumFlag = 'near_high' | 'deep_drawdown' | 'neutral'

export function pctFromHigh(
  price:   number | null,
  high52w: number | null
): number | null {
  if (!price || !high52w || high52w === 0) return null
  return ((price - high52w) / high52w) * 100
}

export function pctFromLow(
  price:  number | null,
  low52w: number | null
): number | null {
  if (!price || !low52w || low52w === 0) return null
  return ((price - low52w) / low52w) * 100
}

export function getMomentumFlag(pctFromHighVal: number | null): MomentumFlag {
  if (pctFromHighVal === null) return 'neutral'
  if (pctFromHighVal >= -5)   return 'near_high'
  if (pctFromHighVal <= -30)  return 'deep_drawdown'
  return 'neutral'
}

/** Adjust a 0–100 recommendation score based on 52-week momentum */
export function applyMomentumScore(
  baseScore:      number,
  pctFromHighVal: number | null
): number {
  const flag = getMomentumFlag(pctFromHighVal)
  if (flag === 'near_high')     return Math.min(100, baseScore + 5)
  if (flag === 'deep_drawdown') return Math.max(0,   baseScore - 10)
  return baseScore
}

/** Compute a 0–100 recommendation score from a snapshot */
export function computeScore(s: {
  pe?:             number | null
  pb?:             number | null
  roe?:            number | null
  debt_equity?:    number | null
  eps_growth_yoy?: number | null
  analyst_buy?:    number | null
  analyst_hold?:   number | null
  analyst_sell?:   number | null
  high_52w?:       number | null
  price?:          number | null
}): number {
  let score = 50

  // Valuation
  if (s.pe != null) score += s.pe < 15 ? 6 : s.pe < 25 ? 2 : s.pe > 40 ? -6 : 0
  if (s.pb != null) score += s.pb < 1.5 ? 5 : s.pb < 3 ? 2 : s.pb > 6 ? -4 : 0

  // Quality
  if (s.roe != null)
    score += s.roe > 0.2 ? 5 : s.roe > 0.1 ? 2 : -2
  if (s.debt_equity != null)
    score += s.debt_equity < 0.5 ? 4 : s.debt_equity > 2 ? -5 : 0
  if (s.eps_growth_yoy != null)
    score += s.eps_growth_yoy > 0.15 ? 6 : s.eps_growth_yoy > 0 ? 2 : -4

  // Analyst consensus
  const total = (s.analyst_buy ?? 0) + (s.analyst_hold ?? 0) + (s.analyst_sell ?? 0)
  if (total > 0) {
    const buyRatio = (s.analyst_buy ?? 0) / total
    score += buyRatio > 0.7 ? 8 : buyRatio > 0.5 ? 3 : buyRatio < 0.3 ? -6 : 0
  }

  // Momentum — Feature 6
  const fromHigh = pctFromHigh(s.price ?? null, s.high_52w ?? null)
  score = applyMomentumScore(score, fromHigh)

  return Math.round(Math.min(100, Math.max(0, score)))
}
