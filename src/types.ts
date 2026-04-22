export interface UniverseRow {
  id:         number
  ticker:     string
  name:       string | null
  exchange:   string | null
  country:    string | null
  region:     string | null
  currency:   string | null
  sector:     string | null
  industry:   string | null
  market_cap: number | null
  asset_type: string | null
  is_active:  number
  added_at:   string | null
}

export interface Snapshot {
  id:                     number
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
  peg?:                   number | null
  fcf_yield?:             number | null
}

export interface FundamentalsRow extends UniverseRow {
  snapshot_id:            number | null
  fetched_at:             string | null
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
  analyst_buy:            number | null
  analyst_hold:           number | null
  analyst_sell:           number | null
  price_target:           number | null
  high_52w:               number | null
  low_52w:                number | null
  beta:                   number | null
  short_percent_of_float: number | null
  peg:                    number | null
  fcf_yield:              number | null
}

export interface SignalRow {
  id:                 number
  ticker:             string
  filed_at:           string | null
  transaction_date:   string | null
  insider_name:       string | null
  relation:           string | null
  transaction_type:   string | null
  shares:             number | null
  value:              number | null
  is_open_market_buy: number
  company_name:       string | null
  sector:             string | null
  industry:           string | null
  current_price:      number | null
  high_52w:           number | null
  low_52w:            number | null
}

export interface SectorAverage {
  sector:        string
  count:         number
  avg_pe:        number | null
  avg_pb:        number | null
  avg_ps:        number | null
  avg_ev_ebitda: number | null
  avg_roe:       number | null
  avg_beta:      number | null
  avg_peg:       number | null
  avg_fcf_yield: number | null
}

export type CapRange = 'all' | 'small' | 'mid' | 'large'
