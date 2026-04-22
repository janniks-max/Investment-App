import { Router } from 'express'
import { rawDb } from '../db.js'

export const fundamentalsRouter = Router()

// GET /api/fundamentals
// Latest snapshot per ticker joined with universe.
// Derives peg and fcf_yield in SQL — Fix 2.
fundamentalsRouter.get('/api/fundamentals', (_req, res) => {
  try {
    const rows = rawDb.prepare(`
      SELECT
        u.ticker,
        u.name,
        u.exchange,
        u.region,
        u.country,
        u.sector,
        u.industry,
        u.market_cap,
        u.currency,
        u.asset_type,
        ps.id            AS snapshot_id,
        ps.fetched_at,
        ps.price,
        ps.pe,
        ps.pb,
        ps.ps,
        ps.ev_ebitda,
        ps.eps,
        ps.eps_growth_yoy,
        ps.revenue_growth_yoy,
        ps.gross_margin,
        ps.operating_margin,
        ps.roe,
        ps.debt_equity,
        ps.free_cash_flow,
        ps.dividend_yield,
        ps.analyst_buy,
        ps.analyst_hold,
        ps.analyst_sell,
        ps.price_target,
        ps.high_52w,
        ps.low_52w,
        ps.beta,
        ps.short_percent_of_float,
        CASE
          WHEN ps.pe IS NOT NULL AND ps.eps_growth_yoy > 0
          THEN ROUND(ps.pe / ps.eps_growth_yoy, 2)
          ELSE NULL
        END AS peg,
        CASE
          WHEN ps.free_cash_flow IS NOT NULL AND u.market_cap > 0
          THEN ROUND(CAST(ps.free_cash_flow AS REAL) / CAST(u.market_cap AS REAL), 4)
          ELSE NULL
        END AS fcf_yield
      FROM universe u
      LEFT JOIN (
        SELECT * FROM price_snapshots p1
        WHERE fetched_at = (
          SELECT MAX(fetched_at) FROM price_snapshots p2
          WHERE p2.ticker = p1.ticker
        )
      ) ps ON ps.ticker = u.ticker
      WHERE u.is_active = 1
      ORDER BY u.ticker
    `).all()

    res.json(rows)
  } catch (err: any) {
    console.error('[fundamentals]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/sector-averages — Fix 2: includes avg_peg and avg_fcf_yield
fundamentalsRouter.get('/api/sector-averages', (_req, res) => {
  try {
    const rows = rawDb.prepare(`
      SELECT
        u.sector,
        COUNT(*)                          AS count,
        AVG(NULLIF(ps.pe,        0))      AS avg_pe,
        AVG(NULLIF(ps.pb,        0))      AS avg_pb,
        AVG(NULLIF(ps.ps,        0))      AS avg_ps,
        AVG(NULLIF(ps.ev_ebitda, 0))      AS avg_ev_ebitda,
        AVG(NULLIF(ps.roe,       0))      AS avg_roe,
        AVG(NULLIF(ps.beta,      0))      AS avg_beta,
        AVG(
          CASE
            WHEN ps.pe IS NOT NULL AND ps.eps_growth_yoy > 0
            THEN ps.pe / ps.eps_growth_yoy
            ELSE NULL
          END
        ) AS avg_peg,
        AVG(
          CASE
            WHEN ps.free_cash_flow IS NOT NULL AND u.market_cap > 0
            THEN CAST(ps.free_cash_flow AS REAL) / CAST(u.market_cap AS REAL)
            ELSE NULL
          END
        ) AS avg_fcf_yield
      FROM (
        SELECT * FROM price_snapshots p1
        WHERE fetched_at = (
          SELECT MAX(fetched_at) FROM price_snapshots p2
          WHERE p2.ticker = p1.ticker
        )
      ) ps
      INNER JOIN universe u ON u.ticker = ps.ticker
      WHERE u.sector IS NOT NULL AND u.is_active = 1
      GROUP BY u.sector
      ORDER BY u.sector
    `).all()

    res.json(rows)
  } catch (err: any) {
    console.error('[sector-averages]', err.message)
    res.status(500).json({ error: err.message })
  }
})
