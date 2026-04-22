import { Router } from 'express'
import { rawDb } from '../db.js'

export const signalsRouter = Router()

// GET /api/signals — Fix 3
// Uses raw SQL to safely read is_open_market_buy regardless of ORM schema state.
// Returns { rows, lastUpdated, total }
signalsRouter.get('/api/signals', (_req, res) => {
  try {
    const rows = rawDb.prepare(`
      SELECT
        it.id,
        it.ticker,
        it.filed_at,
        it.transaction_date,
        it.insider_name,
        it.relation,
        it.transaction_type,
        it.shares,
        it.value,
        it.is_open_market_buy,
        u.name    AS company_name,
        u.sector,
        u.industry,
        ps.price  AS current_price,
        ps.high_52w,
        ps.low_52w
      FROM insider_transactions it
      LEFT JOIN universe u
        ON u.ticker = it.ticker
      LEFT JOIN (
        SELECT ticker, price, high_52w, low_52w
        FROM price_snapshots p1
        WHERE fetched_at = (
          SELECT MAX(fetched_at) FROM price_snapshots p2
          WHERE p2.ticker = p1.ticker
        )
      ) ps ON ps.ticker = it.ticker
      WHERE it.is_open_market_buy = 1
      ORDER BY it.transaction_date DESC
      LIMIT 200
    `).all()

    res.json({
      rows,
      lastUpdated: new Date().toISOString(),
      total: rows.length,
    })
  } catch (err: any) {
    console.error('[signals]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/signals/all — all transactions, not filtered by type
signalsRouter.get('/api/signals/all', (_req, res) => {
  try {
    const rows = rawDb.prepare(`
      SELECT
        it.*,
        u.name AS company_name,
        u.sector
      FROM insider_transactions it
      LEFT JOIN universe u ON u.ticker = it.ticker
      ORDER BY it.transaction_date DESC
      LIMIT 500
    `).all()

    res.json({ rows, lastUpdated: new Date().toISOString() })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
