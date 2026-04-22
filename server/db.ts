import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import path from 'path'
import fs from 'fs'

const dbPath = process.env.DATABASE_URL ?? './data/stocks.db'
const dbDir  = path.dirname(dbPath)
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

export const rawDb = new Database(dbPath)
rawDb.pragma('journal_mode = WAL')
rawDb.pragma('foreign_keys = ON')

export const db = drizzle(rawDb, { schema })

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS universe (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker     TEXT    NOT NULL UNIQUE,
    name       TEXT,
    exchange   TEXT,
    country    TEXT,
    region     TEXT,
    currency   TEXT,
    sector     TEXT,
    industry   TEXT,
    market_cap REAL,
    asset_type TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1,
    added_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS price_snapshots (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker                 TEXT    NOT NULL,
    fetched_at             TEXT    NOT NULL,
    price                  REAL,
    pe                     REAL,
    pb                     REAL,
    ps                     REAL,
    ev_ebitda              REAL,
    eps                    REAL,
    eps_growth_yoy         REAL,
    revenue_growth_yoy     REAL,
    gross_margin           REAL,
    operating_margin       REAL,
    roe                    REAL,
    debt_equity            REAL,
    free_cash_flow         REAL,
    dividend_yield         REAL,
    short_percent_of_float REAL,
    analyst_buy            INTEGER,
    analyst_hold           INTEGER,
    analyst_sell           INTEGER,
    price_target           REAL,
    earnings_date          TEXT,
    high_52w               REAL,
    low_52w                REAL,
    beta                   REAL,
    sma_20                 REAL,
    sma_50                 REAL,
    sma_200                REAL,
    rsi_14                 REAL,
    macd                   REAL,
    macd_signal            REAL,
    volume                 REAL,
    avg_volume             REAL
  );

  CREATE TABLE IF NOT EXISTS insider_transactions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker             TEXT NOT NULL,
    filed_at           TEXT,
    transaction_date   TEXT,
    insider_name       TEXT,
    relation           TEXT,
    transaction_type   TEXT,
    shares             REAL,
    value              REAL,
    fetched_at         TEXT,
    is_open_market_buy INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_ticker  ON price_snapshots(ticker);
  CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON price_snapshots(fetched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_insider_ticker    ON insider_transactions(ticker);
  CREATE INDEX IF NOT EXISTS idx_insider_date      ON insider_transactions(transaction_date DESC);
`)

console.log(`SQLite connected: ${dbPath}`)
