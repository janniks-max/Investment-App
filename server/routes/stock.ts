import { Router } from 'express'
import { db, rawDb } from '../db.js'
import { priceSnapshots, universe } from '../schema.js'
import { eq, desc } from 'drizzle-orm'
import { fetchSnapshot } from '../yahoo.js'

export const stockRouter = Router()

// GET /api/stock/:ticker
// Always returns { info, snapshot } — snapshot is null when no data exists, never 404
stockRouter.get('/api/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  try {
    const [info = null] = await db
      .select()
      .from(universe)
      .where(eq(universe.ticker, ticker))
      .limit(1)

    const [snapshot = null] = await db
      .select()
      .from(priceSnapshots)
      .where(eq(priceSnapshots.ticker, ticker))
      .orderBy(desc(priceSnapshots.fetched_at))
      .limit(1)

    res.json({ info, snapshot })
  } catch (err: any) {
    console.error('[stock]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/stock/:ticker/history
stockRouter.get('/api/stock/:ticker/history', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  try {
    const rows = await db
      .select()
      .from(priceSnapshots)
      .where(eq(priceSnapshots.ticker, ticker))
      .orderBy(desc(priceSnapshots.fetched_at))
      .limit(90)
    res.json(rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/stock/:ticker/fetch  — Fix 1
// Triggers a live Yahoo Finance quoteSummary fetch and writes to price_snapshots
stockRouter.post('/api/stock/:ticker/fetch', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  try {
    const data = await fetchSnapshot(ticker)

    await db.insert(priceSnapshots).values(data)

    // Upsert into universe so the ticker is always tracked after a fetch
    await db
      .insert(universe)
      .values({ ticker })
      .onConflictDoNothing()

    res.json({ success: true, fetched_at: data.fetched_at, snapshot: data })
  } catch (err: any) {
    console.error(`[fetch] ${ticker}:`, err.message)
    res.status(500).json({ error: err.message ?? 'Yahoo Finance fetch failed' })
  }
})

// GET /api/universe
stockRouter.get('/api/universe', async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(universe)
      .orderBy(universe.ticker)
    res.json(rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/universe
stockRouter.post('/api/universe', async (req, res) => {
  const {
    ticker, name, exchange, country, region,
    currency, sector, industry, market_cap, asset_type,
  } = req.body
  if (!ticker) return res.status(400).json({ error: 'ticker required' })
  try {
    await db
      .insert(universe)
      .values({
        ticker: ticker.toUpperCase(),
        name, exchange, country, region,
        currency, sector, industry, market_cap, asset_type,
      })
      .onConflictDoUpdate({
        target: universe.ticker,
        set: { name, exchange, country, region, currency, sector, industry, market_cap, asset_type },
      })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
