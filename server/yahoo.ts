import yahooFinance from 'yahoo-finance2'

export interface SnapshotInsert {
  ticker:                 string
  fetched_at:             string
  price:                  number | null
  pe:                     number | null
  pb:                     number | null
  ps:                     number | null
  ev_ebitda:              number | null
  eps:                    number | null
  eps_growth_yoy:         number | null
  revenue_growth_yoy:     number | null
  gross_margin:           number | null
  operating_margin:       number | null
  roe:                    number | null
  debt_equity:            number | null
  free_cash_flow:         number | null
  dividend_yield:         number | null
  short_percent_of_float: number | null
  analyst_buy:            number | null
  analyst_hold:           number | null
  analyst_sell:           number | null
  price_target:           number | null
  earnings_date:          string | null
  high_52w:               number | null
  low_52w:                number | null
  beta:                   number | null
}

export async function fetchSnapshot(ticker: string): Promise<SnapshotInsert> {
  const upper = ticker.toUpperCase()

  const result = await yahooFinance.quoteSummary(upper, {
    modules: [
      'price',
      'summaryDetail',
      'financialData',
      'defaultKeyStatistics',
      'recommendationTrend',
      'calendarEvents',
    ],
  })

  const p  = (result.price               ?? {}) as Record<string, any>
  const sd = (result.summaryDetail        ?? {}) as Record<string, any>
  const fd = (result.financialData        ?? {}) as Record<string, any>
  const ks = (result.defaultKeyStatistics ?? {}) as Record<string, any>
  const rt = ((result.recommendationTrend?.trend ?? [])[0] ?? {}) as Record<string, any>
  const ce = (result.calendarEvents       ?? {}) as Record<string, any>

  const earningsRaw = ce.earnings?.earningsDate?.[0]

  return {
    ticker:                 upper,
    fetched_at:             new Date().toISOString(),
    price:                  p.regularMarketPrice              ?? null,
    pe:                     sd.trailingPE                     ?? null,
    pb:                     ks.priceToBook                    ?? null,
    ps:                     ks.priceToSalesTrailing12Months   ?? null,
    ev_ebitda:              ks.enterpriseToEbitda             ?? null,
    eps:                    ks.trailingEps                    ?? null,
    eps_growth_yoy:         ks.earningsQuarterlyGrowth        ?? null,
    revenue_growth_yoy:     fd.revenueGrowth                  ?? null,
    gross_margin:           fd.grossMargins                   ?? null,
    operating_margin:       fd.operatingMargins               ?? null,
    roe:                    fd.returnOnEquity                 ?? null,
    debt_equity:            fd.debtToEquity                   ?? null,
    free_cash_flow:         fd.freeCashflow                   ?? null,
    dividend_yield:         sd.dividendYield                  ?? null,
    short_percent_of_float: ks.shortPercentOfFloat            ?? null,
    analyst_buy:            ((rt.strongBuy ?? 0) + (rt.buy ?? 0)) || null,
    analyst_hold:           rt.hold                           ?? null,
    analyst_sell:           ((rt.sell ?? 0) + (rt.strongSell ?? 0)) || null,
    price_target:           fd.targetMeanPrice                ?? null,
    earnings_date:          earningsRaw ? new Date(earningsRaw).toISOString() : null,
    high_52w:               sd.fiftyTwoWeekHigh               ?? null,
    low_52w:                sd.fiftyTwoWeekLow                ?? null,
    beta:                   ks.beta                           ?? null,
  }
}
