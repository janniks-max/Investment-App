import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "fs";
import { eq, desc, like, and, sql } from "drizzle-orm";
import {
  universe,
  watchlists,
  priceSnapshots,
  recommendations,
  backtestRecords,
  refreshLog,
  settings,
  opportunityScores,
  inviteTokens,
  accessLinks,
  failedStocks,
  type Universe,
  type InsertUniverse,
  type Watchlist,
  type InsertWatchlist,
  type PriceSnapshot,
  type Recommendation,
  type BacktestRecord,
  type RefreshLog,
  type OpportunityScore,
  type InviteToken,
  type AccessLink,
  type FailedStock,
} from "../shared/schema";
import type { RawStockData } from "./lib/dataFetcher";
import type { RankingResult } from "./lib/rankingEngine";

const DB_PATH = process.env.DB_PATH || "./stock-recommender.db";

// ─── DB open with corrupt-recovery ───────────────────────────────────────────
// Try to open and do a quick integrity probe. Only delete + recreate if the DB
// is genuinely unreadable (SQLITE_CORRUPT / disk I/O error) or the file is
// missing its schema entirely. Any other error throws so the process crashes
// visibly instead of silently wiping a healthy DB.
function openDatabase(): Database.Database {
  try {
    const db = new Database(DB_PATH);
    db.exec("SELECT 1"); // lightweight readability probe
    return db;
  } catch (err: any) {
    const msg: string = (err?.message ?? String(err)).toLowerCase();
    const isCorrupt =
      msg.includes("disk i/o error") ||
      msg.includes("sqlite_corrupt") ||
      msg.includes("database disk image is malformed") ||
      msg.includes("file is not a database") ||
      msg.includes("no such table") ||
      msg.includes("unable to open database");

    if (!isCorrupt) {
      // Unknown error — throw so the process crashes visibly in Railway logs
      // instead of silently wiping a healthy DB.
      console.error("[Storage] DB probe threw unexpected error — refusing to wipe. Crashing:", err);
      throw err;
    }

    console.warn(
      `[Storage] DB unreadable (${err?.message}) — wiping corrupt file and starting fresh.`,
      "Matched pattern:", msg.slice(0, 80)
    );
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(DB_PATH + ext); } catch {}
    }
    return new Database(DB_PATH); // fresh empty DB
  }
}

const sqlite = openDatabase();
// journal_mode=OFF must be the VERY FIRST SQL executed so SQLite never tries to
// create/write a journal or WAL file. This lets us survive a completely full disk.
// The cleanup migration will VACUUM + restore WAL mode once space is freed.
try { sqlite.exec("PRAGMA journal_mode=OFF"); } catch {}
try { sqlite.exec("PRAGMA synchronous=OFF"); } catch {}
const db = drizzle(sqlite);
export { sqlite as rawSqlite };

// Run migrations
function migrate() {
  const dbRaw = sqlite;
  // journal_mode=OFF + synchronous=OFF already set above, before drizzle init.
  try { dbRaw.exec("PRAGMA cache_size=10000"); } catch {}
  try { dbRaw.exec("PRAGMA temp_store=MEMORY"); } catch {}
  dbRaw.exec(`
    CREATE TABLE IF NOT EXISTS universe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL,
      country TEXT NOT NULL,
      region TEXT NOT NULL,
      currency TEXT NOT NULL,
      sector TEXT,
      industry TEXT,
      market_cap REAL,
      asset_type TEXT NOT NULL DEFAULT 'stock',
      is_active INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      tickers TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      data_source TEXT NOT NULL,
      data_freshness TEXT NOT NULL,
      price REAL, open REAL, high REAL, low REAL, prev_close REAL,
      change REAL, change_pct REAL, volume INTEGER, avg_volume_20d INTEGER,
      sma20 REAL, sma50 REAL, sma200 REAL, ema12 REAL, ema26 REAL,
      rsi14 REAL, macd REAL, macd_signal REAL, atr14 REAL, beta REAL,
      high_52w REAL, low_52w REAL,
      ret_1d REAL, ret_5d REAL, ret_20d REAL, ret_60d REAL, ret_120d REAL, ret_250d REAL,
      pe REAL, pb REAL, ps REAL, ev_ebitda REAL, eps REAL,
      eps_growth_yoy REAL, revenue_growth_yoy REAL,
      gross_margin REAL, operating_margin REAL, roe REAL,
      debt_equity REAL, free_cash_flow REAL, dividend_yield REAL,
      analyst_buy INTEGER, analyst_hold INTEGER, analyst_sell INTEGER,
      price_target REAL, earnings_date TEXT,
      sentiment_score REAL, news_count_24h INTEGER,
      raw_json TEXT, error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      snapshot_id INTEGER,
      signal_20d TEXT, signal_60d TEXT, signal_120d TEXT, signal_250d TEXT,
      confidence_20d REAL, confidence_60d REAL, confidence_120d REAL, confidence_250d REAL,
      factor_momentum REAL, factor_valuation REAL, factor_quality REAL,
      factor_earnings REAL, factor_trend REAL, factor_volatility REAL, factor_sentiment REAL,
      composite_score REAL,
      risk_flags TEXT DEFAULT '[]',
      explanation TEXT,
      inputs_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS backtest_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      signal_date TEXT NOT NULL,
      signal TEXT NOT NULL,
      horizon INTEGER NOT NULL,
      composite_score REAL,
      entry_price REAL,
      exit_price REAL,
      actual_return REAL,
      benchmark_return REAL,
      outcome TEXT,
      evaluated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS refresh_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      tickers_attempted INTEGER DEFAULT 0,
      tickers_succeeded INTEGER DEFAULT 0,
      tickers_failed INTEGER DEFAULT 0,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      interval_minutes INTEGER,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunity_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      computed_at TEXT NOT NULL,
      upside_score REAL,
      risk_score REAL,
      raw_analyst_upside_pct REAL,
      raw_52w_high_upside_pct REAL,
      raw_revenue_growth_pct REAL,
      raw_eps_growth_pct REAL,
      raw_drawdown_risk_pct REAL,
      raw_atr_pct REAL,
      raw_beta REAL,
      raw_debt_equity REAL,
      thematic_multiplier REAL,
      upside_analyst_target REAL,
      upside_52w_high REAL,
      upside_revenue_growth REAL,
      upside_eps_growth REAL,
      risk_drawdown REAL,
      risk_atr REAL,
      risk_beta REAL,
      risk_debt_equity REAL,
      theme_tags TEXT NOT NULL DEFAULT '[]',
      horizon_scores TEXT NOT NULL DEFAULT '{}',
      snapshot_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON price_snapshots(ticker);
    CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON price_snapshots(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recs_ticker ON recommendations(ticker);
    CREATE INDEX IF NOT EXISTS idx_recs_generated ON recommendations(generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_universe_active ON universe(is_active);
    CREATE INDEX IF NOT EXISTS idx_opp_upside ON opportunity_scores(upside_score DESC);
    CREATE INDEX IF NOT EXISTS idx_opp_risk ON opportunity_scores(risk_score ASC);

    CREATE TABLE IF NOT EXISTS invite_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS access_links (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS failed_stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      last_error TEXT NOT NULL,
      error_category TEXT NOT NULL DEFAULT 'unknown',
      consecutive_fails INTEGER NOT NULL DEFAULT 1,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL,
      auto_removed INTEGER NOT NULL DEFAULT 0,
      auto_removed_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS insider_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      filed_at TEXT,
      transaction_date TEXT,
      insider_name TEXT,
      relation TEXT,
      transaction_type TEXT,
      shares REAL,
      value REAL,
      fetched_at TEXT NOT NULL
    );
  `);
}

try {
  migrate();
} catch (e) {
  // Non-fatal: log and continue so the HTTP server can start.
  // The /api/admin/emergency-cleanup endpoint can fix data issues at runtime.
  console.error("[Storage] migrate() failed — app will start in degraded mode:", e);
}

// ─── All post-migrate IIFEs wrapped so SQLITE_CORRUPT doesn't crash the process ───
try {

// ─── opportunity_scores column migrations ────────────────────────────────────
// The old schema had different columns. We add the new v2 columns if missing.
// SQLite does not support DROP COLUMN, but we just ignore old columns.
(function migrateOpportunityScores() {
  const existingCols = (sqlite.prepare("PRAGMA table_info(opportunity_scores)").all() as any[])
    .map((c: any) => c.name as string);

  const newCols: [string, string][] = [
    ["raw_analyst_upside_pct", "REAL"],
    ["raw_52w_high_upside_pct", "REAL"],
    ["raw_revenue_growth_pct", "REAL"],
    ["raw_eps_growth_pct", "REAL"],
    ["raw_drawdown_risk_pct", "REAL"],
    ["raw_atr_pct", "REAL"],
    ["raw_beta", "REAL"],
    ["raw_debt_equity", "REAL"],
    ["thematic_multiplier", "REAL"],
    ["upside_52w_high", "REAL"],
    ["risk_drawdown", "REAL"],
    ["risk_beta", "REAL"],
    ["upside_valuation_rerating", "REAL"],
  ];

  for (const [col, type] of newCols) {
    if (!existingCols.includes(col)) {
      try {
        sqlite.exec(`ALTER TABLE opportunity_scores ADD COLUMN ${col} ${type}`);
      } catch { /* column already exists */ }
    }
  }
})();

// ─── Sector reclassification migration ──────────────────────────────────────
// Runs once on startup. Re-classifies all universe rows using the canonical
// sector list so the sector filter dropdown works correctly.
(function migrateSectors() {
  try {
    const { classifySector } = require("./lib/sectorClassifier");
    const rows = sqlite.prepare("SELECT ticker, name, sector, industry FROM universe").all() as any[];
    const stmt = sqlite.prepare("UPDATE universe SET sector = ? WHERE ticker = ?");
    let updated = 0;
    // Track per-sector counts for stocks moving OUT of "Other"
    const reclassifiedFrom: Record<string, number> = {};
    const reclassifiedTo: Record<string, number> = {};
    for (const row of rows) {
      // 3-layer classification: pass ticker + name so Layer 2 (overrides) and Layer 3 (name keywords) fire
      const newSector = classifySector(row.sector, row.industry, row.ticker, row.name);
      // Also fix any previously-lowercased ETF sectors stored by an earlier migration run.
      const etfFixMap: Record<string, string> = {
        "broad market": "Broad Market",
        "international": "International",
        "emerging markets": "Emerging Markets",
        "small cap": "Small Cap",
        "commodities": "Commodities",
      };
      const fixed = etfFixMap[row.sector] ?? newSector;
      if (fixed !== row.sector) {
        stmt.run(fixed, row.ticker);
        updated++;
        // Track movements out of Other for reporting
        const from = row.sector || "Other";
        reclassifiedFrom[from] = (reclassifiedFrom[from] || 0) + 1;
        reclassifiedTo[fixed] = (reclassifiedTo[fixed] || 0) + 1;
      }
    }
    if (updated > 0) {
      console.log(`[Migration] Reclassified ${updated} sectors`);
      // Log per-sector breakdown of what moved OUT
      const fromOther = reclassifiedFrom["Other"] || 0;
      if (fromOther > 0) {
        console.log(`[Migration] ${fromOther} stocks moved out of "Other" → breakdown by new sector:`);
        Object.entries(reclassifiedTo)
          .sort(([, a], [, b]) => b - a)
          .forEach(([sector, count]) => console.log(`  → ${sector}: ${count}`));
      }
      // Log other sectors that changed
      const otherFromSectors = Object.entries(reclassifiedFrom).filter(([s]) => s !== "Other");
      if (otherFromSectors.length > 0) {
        console.log(`[Migration] Also reclassified from non-Other sectors:`);
        otherFromSectors
          .sort(([, a], [, b]) => b - a)
          .forEach(([sector, count]) => console.log(`  ← ${sector}: ${count} stocks`));
      }
    }
  } catch (e) {
    console.error("[Migration] Sector reclassification failed:", e);
  }
})();

// ─── Batch sector lookup migration ───────────────────────────────────────────
// One-time: applies hardcoded name+sector data for Asian/European/US mid-cap
// tickers that Yahoo Finance never returns sector metadata for.
(function migrateBatchLookup() {
  try {
    const { SECTOR_LOOKUP } = require("./lib/sectorLookup");
    const rows = sqlite.prepare(
      "SELECT ticker, name, sector FROM universe WHERE sector = 'Other' OR sector IS NULL OR sector = ''"
    ).all() as any[];
    if (rows.length === 0) return; // nothing left in Other

    const updateBoth   = sqlite.prepare("UPDATE universe SET name = ?, sector = ? WHERE ticker = ?");
    const updateSector = sqlite.prepare("UPDATE universe SET sector = ? WHERE ticker = ?");
    const updateName   = sqlite.prepare("UPDATE universe SET name = ? WHERE ticker = ?");

    let updSector = 0;
    let updName   = 0;
    const sectorCounts: Record<string, number> = {};

    for (const row of rows) {
      const entry = SECTOR_LOOKUP[row.ticker];
      if (!entry) continue;

      const isBareName = !row.name || row.name === row.ticker || /^[\d\s.]+$/.test(row.name);
      const sectorChanged = entry.sector !== row.sector;
      const nameChanged   = isBareName && entry.name;

      if (sectorChanged && nameChanged) {
        updateBoth.run(entry.name, entry.sector, row.ticker);
        updSector++; updName++;
      } else if (sectorChanged) {
        updateSector.run(entry.sector, row.ticker);
        updSector++;
      } else if (nameChanged) {
        updateName.run(entry.name, row.ticker);
        updName++;
      }

      if (sectorChanged) {
        sectorCounts[entry.sector] = (sectorCounts[entry.sector] || 0) + 1;
      }
    }

    if (updSector > 0 || updName > 0) {
      console.log(`[Migration:BatchLookup] Sectors fixed: ${updSector}, Names fixed: ${updName}`);
      console.log(`[Migration:BatchLookup] Sector breakdown:`);
      Object.entries(sectorCounts)
        .sort(([, a], [, b]) => b - a)
        .forEach(([s, n]) => console.log(`  → ${s}: ${n}`));
    } else {
      console.log(`[Migration:BatchLookup] Nothing to update (already applied)`);
    }
  } catch (e) {
    console.error("[Migration:BatchLookup] Failed:", e);
  }
})();

// ─── Step 1: One-time cleanup — deduplicate recommendations rows IN-PLACE ────
// Must run BEFORE the UNIQUE constraint rebuild (which needs free space).
// Guarded by a settings key so it only ever runs once.
(function migrateRecommendationsCleanup() {
  try {
    // v3 guard
    const done = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_recs_cleanup_v3'").get() as any;
    if (done) return;

    // journal_mode=OFF was already set at top of migrate() — no journal written,
    // no disk space needed for writes. Confirm it's still OFF here.
    try { sqlite.exec("PRAGMA journal_mode=OFF"); } catch {}
    try { sqlite.exec("PRAGMA synchronous=OFF"); } catch {}

    const before = sqlite.prepare("SELECT COUNT(*) as cnt FROM recommendations").get() as any;
    const pageSize: any = sqlite.prepare("PRAGMA page_size").get();
    const pageCount: any = sqlite.prepare("PRAGMA page_count").get();
    const sizeBefore = (pageSize.page_size * pageCount.page_count / 1024 / 1024).toFixed(2);
    console.log(`[Cleanup] recommendations before: ${before.cnt} rows, DB ~${sizeBefore} MB`);

    // Batch-delete in chunks of 10,000 rows to keep per-transaction journal size small.
    // Each pass removes up to 10k old duplicate rows and commits immediately.
    let totalDeleted = 0;
    for (let pass = 0; pass < 500; pass++) {
      const result = sqlite.prepare(`
        DELETE FROM recommendations
        WHERE id IN (
          SELECT r.id FROM recommendations r
          WHERE r.id != (
            SELECT MAX(id) FROM recommendations r2 WHERE r2.ticker = r.ticker
          )
          LIMIT 5000
        )
      `).run();
      totalDeleted += result.changes;
      if (result.changes === 0) break;
      console.log(`[Cleanup] pass ${pass + 1}: deleted ${result.changes} rows (total so far: ${totalDeleted})`);
    }

    const after = sqlite.prepare("SELECT COUNT(*) as cnt FROM recommendations").get() as any;
    console.log(`[Cleanup] recommendations after DELETE: ${after.cnt} rows`);

    // VACUUM to reclaim disk space; restore WAL mode regardless
    try {
      sqlite.exec("VACUUM");
      const pageCount2: any = sqlite.prepare("PRAGMA page_count").get();
      const sizeAfter = (pageSize.page_size * pageCount2.page_count / 1024 / 1024).toFixed(2);
      console.log(`[Cleanup] After VACUUM: DB ~${sizeAfter} MB`);
    } catch (vacErr) {
      console.warn("[Cleanup] VACUUM skipped:", vacErr);
    }
    try { sqlite.exec("PRAGMA journal_mode=WAL"); } catch {}
    try { sqlite.exec("PRAGMA synchronous=NORMAL"); } catch {}

    // Mark as done
    sqlite.exec(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('migration_recs_cleanup_v3', '1', datetime('now'))`);
    console.log("[Cleanup] One-time recommendations cleanup complete");
  } catch (e) {
    console.error("[Cleanup] recommendations cleanup error:", e);
    // Always try to restore WAL mode
    try { sqlite.exec("PRAGMA journal_mode=WAL"); sqlite.exec("PRAGMA synchronous=NORMAL"); } catch {}
  }
})();

// ─── Step 2: Add UNIQUE(ticker) constraint via table rebuild ─────────────────
// Runs after cleanup so there's enough free space for the temp table.
// SQLite can't ADD CONSTRAINT after creation — rebuild required.
(function migrateRecommendationsUnique() {
  try {
    const indexRows = sqlite.prepare("PRAGMA index_list(recommendations)").all() as any[];
    const hasUnique = indexRows.some((r: any) => r.unique === 1 && (() => {
      const cols = sqlite.prepare(`PRAGMA index_info(${r.name})`).all() as any[];
      return cols.length === 1 && cols[0].name === "ticker";
    })());
    if (!hasUnique) {
      console.log("[Migration] Adding UNIQUE(ticker) to recommendations via table rebuild");
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS recommendations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker TEXT NOT NULL UNIQUE,
          generated_at TEXT NOT NULL,
          snapshot_id INTEGER,
          signal_20d TEXT, signal_60d TEXT, signal_120d TEXT, signal_250d TEXT,
          confidence_20d REAL, confidence_60d REAL, confidence_120d REAL, confidence_250d REAL,
          factor_momentum REAL, factor_valuation REAL, factor_quality REAL,
          factor_earnings REAL, factor_trend REAL, factor_volatility REAL, factor_sentiment REAL,
          composite_score REAL,
          risk_flags TEXT DEFAULT '[]',
          explanation TEXT,
          inputs_hash TEXT
        );
        INSERT OR REPLACE INTO recommendations_new
          SELECT * FROM (
            SELECT * FROM recommendations
            ORDER BY id DESC
          )
          GROUP BY ticker;
        DROP TABLE recommendations;
        ALTER TABLE recommendations_new RENAME TO recommendations;
        CREATE INDEX IF NOT EXISTS idx_recs_ticker ON recommendations(ticker);
        CREATE INDEX IF NOT EXISTS idx_recs_generated ON recommendations(generated_at DESC);
      `);
      console.log("[Migration] recommendations UNIQUE(ticker) migration complete");
    }
  } catch (e) {
    console.error("[Migration] recommendations UNIQUE migration error:", e);
  }
})();

// ─── insider_transactions.is_open_market_buy column migration ────────────────────────
(function migrateInsiderBuyFlag() {
  try {
    const cols = (sqlite.prepare("PRAGMA table_info(insider_transactions)").all() as any[]).map((c: any) => c.name as string);
    if (!cols.includes("is_open_market_buy")) {
      sqlite.exec("ALTER TABLE insider_transactions ADD COLUMN is_open_market_buy INTEGER NOT NULL DEFAULT 0");
    }
  } catch { /* already exists */ }
})();

// ─── Backfill insider transaction_type from shares/value when description is null ─────
// Yahoo's insiderTransactions API no longer returns transactionDescription reliably.
// Synthesize type: positive shares+value → "Purchase"; negative shares → "Sale".
// Runs every startup (idempotent); subsequent inserts use the fixed bulk-refresh logic.
(function backfillInsiderTransactionType() {
  try {
    sqlite.exec(`
      UPDATE insider_transactions
      SET transaction_type = 'Purchase',
          is_open_market_buy = 1
      WHERE transaction_type IS NULL
        AND shares > 0
        AND value > 0
    `);
    sqlite.exec(`
      UPDATE insider_transactions
      SET transaction_type = 'Sale',
          is_open_market_buy = 0
      WHERE transaction_type IS NULL
        AND shares < 0
    `);
    console.log("[Storage] Backfilled insider transaction_type from shares/value");
  } catch (e: any) {
    console.warn("[Storage] insider_type backfill failed (non-fatal):", e?.message);
  }
})();


// ─── short_percent_of_float column migration ────────────────────────────────────
(function migrateShortInterest() {
  try {
    const cols = (sqlite.prepare("PRAGMA table_info(price_snapshots)").all() as any[]).map((c: any) => c.name as string);
    if (!cols.includes("short_percent_of_float")) {
      sqlite.exec("ALTER TABLE price_snapshots ADD COLUMN short_percent_of_float REAL");
    }
  } catch { /* already exists */ }
})();

// ─── FX price columns migration (v4) ─────────────────────────────────────────
// Adds native_currency, price_eur, price_usd to price_snapshots.
(function migrateFxPriceColumns() {
  try {
    const cols = (sqlite.prepare("PRAGMA table_info(price_snapshots)").all() as any[]).map((c: any) => c.name as string);
    if (!cols.includes("native_currency")) sqlite.exec("ALTER TABLE price_snapshots ADD COLUMN native_currency TEXT");
    if (!cols.includes("price_eur"))       sqlite.exec("ALTER TABLE price_snapshots ADD COLUMN price_eur REAL");
    if (!cols.includes("price_usd"))       sqlite.exec("ALTER TABLE price_snapshots ADD COLUMN price_usd REAL");
  } catch { /* already exists */ }
})();

// ─── Fix #11A: data coverage + sector columns on recommendations ──────────────
(function migrateCoverageColumns() {
  try {
    const cols = (sqlite.prepare("PRAGMA table_info(recommendations)").all() as any[]).map((c: any) => c.name as string);
    if (!cols.includes("data_coverage"))  sqlite.exec("ALTER TABLE recommendations ADD COLUMN data_coverage REAL");
    if (!cols.includes("coverage_tier"))  sqlite.exec("ALTER TABLE recommendations ADD COLUMN coverage_tier TEXT");
    if (!cols.includes("sector_group"))   sqlite.exec("ALTER TABLE recommendations ADD COLUMN sector_group TEXT");
  } catch { /* already exists */ }
})();

} catch (e) {
  console.error("[Storage] Post-migrate IIFEs failed (DB may be corrupt — use /api/admin/emergency-cleanup):", e);
}

// ─── Restore production journal mode ─────────────────────────────────────────
// Startup used journal_mode=OFF + synchronous=OFF to survive full-disk.
// Now that all migrations are complete, switch to WAL for crash safety.
// synchronous=NORMAL is a reasonable production balance (no fsync per commit,
// but WAL checkpoints are still durable on OS crash).
try {
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA synchronous=NORMAL");
  console.log("[Storage] journal_mode=WAL + synchronous=NORMAL set");
} catch (e) {
  console.warn("[Storage] Could not restore WAL mode (non-fatal):", e);
}

// Default global universe (broad coverage: US + EU + ETFs)
const DEFAULT_UNIVERSE: Omit<InsertUniverse, "addedAt">[] = [
  // US Large Cap
  { ticker: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Consumer Electronics", assetType: "stock" },
  { ticker: "MSFT", name: "Microsoft Corp.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Software", assetType: "stock" },
  { ticker: "NVDA", name: "NVIDIA Corp.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Semiconductors", assetType: "stock" },
  { ticker: "GOOGL", name: "Alphabet Inc.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Internet", assetType: "stock" },
  { ticker: "AMZN", name: "Amazon.com Inc.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Consumer Discretionary", industry: "E-Commerce", assetType: "stock" },
  { ticker: "META", name: "Meta Platforms", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Social Media", assetType: "stock" },
  { ticker: "TSLA", name: "Tesla Inc.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Consumer Discretionary", industry: "EVs", assetType: "stock" },
  { ticker: "JPM", name: "JPMorgan Chase", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Financials", industry: "Banks", assetType: "stock" },
  { ticker: "V", name: "Visa Inc.", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Financials", industry: "Payments", assetType: "stock" },
  { ticker: "JNJ", name: "Johnson & Johnson", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  { ticker: "UNH", name: "UnitedHealth Group", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Healthcare", industry: "Managed Care", assetType: "stock" },
  { ticker: "XOM", name: "ExxonMobil", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Energy", industry: "Oil & Gas", assetType: "stock" },
  { ticker: "BRK-B", name: "Berkshire Hathaway B", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Financials", industry: "Conglomerates", assetType: "stock" },
  { ticker: "WMT", name: "Walmart Inc.", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Consumer Staples", industry: "Retail", assetType: "stock" },
  { ticker: "LLY", name: "Eli Lilly", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  // US Mid/Growth
  { ticker: "AMD", name: "Advanced Micro Devices", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Semiconductors", assetType: "stock" },
  { ticker: "NFLX", name: "Netflix Inc.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Communication", industry: "Streaming", assetType: "stock" },
  { ticker: "CRM", name: "Salesforce Inc.", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "CRM Software", assetType: "stock" },
  { ticker: "ADBE", name: "Adobe Inc.", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Software", assetType: "stock" },
  { ticker: "NOW", name: "ServiceNow Inc.", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "Software", assetType: "stock" },
  // European stocks — native exchange quotes (EUR/GBp/DKK)
  { ticker: "ASML.AS", name: "ASML Holding (Amsterdam)", exchange: "EURONEXT", country: "NL", region: "Europe", currency: "EUR", sector: "Technology", industry: "Semiconductors", assetType: "stock" },
  { ticker: "SAP.DE", name: "SAP SE (Frankfurt)", exchange: "XETRA", country: "DE", region: "Europe", currency: "EUR", sector: "Technology", industry: "ERP Software", assetType: "stock" },
  { ticker: "NVO.CO", name: "Novo Nordisk A/S (Copenhagen)", exchange: "OMX", country: "DK", region: "Europe", currency: "DKK", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  { ticker: "MC.PA", name: "LVMH Moët Hennessy (Paris)", exchange: "EURONEXT", country: "FR", region: "Europe", currency: "EUR", sector: "Consumer Discretionary", industry: "Luxury Goods", assetType: "stock" },
  { ticker: "SHEL.L", name: "Shell PLC (London)", exchange: "LSE", country: "GB", region: "Europe", currency: "GBp", sector: "Energy", industry: "Oil & Gas", assetType: "stock" },
  { ticker: "TTE.PA", name: "TotalEnergies SE (Paris)", exchange: "EURONEXT", country: "FR", region: "Europe", currency: "EUR", sector: "Energy", industry: "Oil & Gas", assetType: "stock" },
  { ticker: "SIE.DE", name: "Siemens AG (Frankfurt)", exchange: "XETRA", country: "DE", region: "Europe", currency: "EUR", sector: "Industrials", industry: "Conglomerates", assetType: "stock" },
  { ticker: "ALV.DE", name: "Allianz SE (Frankfurt)", exchange: "XETRA", country: "DE", region: "Europe", currency: "EUR", sector: "Financials", industry: "Insurance", assetType: "stock" },
  { ticker: "BAYN.DE", name: "Bayer AG (Frankfurt)", exchange: "XETRA", country: "DE", region: "Europe", currency: "EUR", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  { ticker: "AZN.L", name: "AstraZeneca PLC (London)", exchange: "LSE", country: "GB", region: "Europe", currency: "GBp", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  { ticker: "AIR.PA", name: "Airbus SE (Paris)", exchange: "EURONEXT", country: "FR", region: "Europe", currency: "EUR", sector: "Industrials", industry: "Aerospace & Defense", assetType: "stock" },
  { ticker: "OR.PA", name: "L'Oréal (Paris)", exchange: "EURONEXT", country: "FR", region: "Europe", currency: "EUR", sector: "Consumer Staples", industry: "Personal Care", assetType: "stock" },
  { ticker: "NESN.SW", name: "Nestlé SA (Zurich)", exchange: "SIX", country: "CH", region: "Europe", currency: "CHF", sector: "Consumer Staples", industry: "Food & Beverage", assetType: "stock" },
  { ticker: "NOVN.SW", name: "Novartis AG (Zurich)", exchange: "SIX", country: "CH", region: "Europe", currency: "CHF", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  { ticker: "ROG.SW", name: "Roche Holding (Zurich)", exchange: "SIX", country: "CH", region: "Europe", currency: "CHF", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  { ticker: "BBVA.MC", name: "BBVA (Madrid)", exchange: "BME", country: "ES", region: "Europe", currency: "EUR", sector: "Financials", industry: "Banks", assetType: "stock" },
  { ticker: "BNP.PA", name: "BNP Paribas (Paris)", exchange: "EURONEXT", country: "FR", region: "Europe", currency: "EUR", sector: "Financials", industry: "Banks", assetType: "stock" },
  { ticker: "DTE.DE", name: "Deutsche Telekom (Frankfurt)", exchange: "XETRA", country: "DE", region: "Europe", currency: "EUR", sector: "Communication", industry: "Telecom", assetType: "stock" },
  { ticker: "BP.L", name: "BP PLC (London)", exchange: "LSE", country: "GB", region: "Europe", currency: "GBp", sector: "Energy", industry: "Oil & Gas", assetType: "stock" },
  { ticker: "GSK.L", name: "GSK PLC (London)", exchange: "LSE", country: "GB", region: "Europe", currency: "GBp", sector: "Healthcare", industry: "Pharmaceuticals", assetType: "stock" },
  // ETFs
  { ticker: "SPY", name: "SPDR S&P 500 ETF", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Broad Market", industry: "ETF", assetType: "etf" },
  { ticker: "QQQ", name: "Invesco QQQ Trust", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", sector: "Technology", industry: "ETF", assetType: "etf" },
  { ticker: "VTI", name: "Vanguard Total Stock Market ETF", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Broad Market", industry: "ETF", assetType: "etf" },
  { ticker: "EFA", name: "iShares MSCI EAFE ETF", exchange: "NYSE", country: "US", region: "Global", currency: "USD", sector: "International", industry: "ETF", assetType: "etf" },
  { ticker: "EEM", name: "iShares MSCI Emerging Markets ETF", exchange: "NYSE", country: "US", region: "Global", currency: "USD", sector: "Emerging Markets", industry: "ETF", assetType: "etf" },
  { ticker: "VEA", name: "Vanguard FTSE Developed Markets ETF", exchange: "NYSE", country: "US", region: "Global", currency: "USD", sector: "International", industry: "ETF", assetType: "etf" },
  { ticker: "XLE", name: "Energy Select Sector SPDR", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Energy", industry: "ETF", assetType: "etf" },
  { ticker: "XLF", name: "Financial Select Sector SPDR", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Financials", industry: "ETF", assetType: "etf" },
  { ticker: "IWM", name: "iShares Russell 2000 ETF", exchange: "NYSE", country: "US", region: "Americas", currency: "USD", sector: "Small Cap", industry: "ETF", assetType: "etf" },
  { ticker: "GLD", name: "SPDR Gold Shares", exchange: "NYSE", country: "US", region: "Global", currency: "USD", sector: "Commodities", industry: "ETF", assetType: "etf" },
];

export interface IStorage {
  // Universe
  getActiveUniverseStocks(): Promise<Universe[]>;
  getAllUniverseStocks(filters?: UniverseFilters): Promise<Universe[]>;
  getUniverseItem(ticker: string): Promise<Universe | null>; // Fix #12
  addToUniverse(stock: InsertUniverse): Promise<Universe>;
  removeFromUniverse(ticker: string): Promise<void>;
  seedDefaultUniverse(): Promise<void>;

  // Snapshots
  saveSnapshot(raw: RawStockData): Promise<number>;
  getLatestSnapshot(ticker: string): Promise<PriceSnapshot | null>;

  // Recommendations
  saveRecommendation(ranking: RankingResult, snapshotId: number): Promise<void>;
  getLatestRecommendations(filters?: RecommendationFilters): Promise<EnrichedRecommendation[]>;
  getRecommendationHistory(ticker: string, limit?: number): Promise<Recommendation[]>;
  getLatestRecommendationForTicker(ticker: string): Promise<Recommendation | null>;

  // Watchlists
  getWatchlists(): Promise<Watchlist[]>;
  createWatchlist(data: InsertWatchlist): Promise<Watchlist>;
  updateWatchlist(id: number, data: Partial<InsertWatchlist>): Promise<Watchlist | null>;
  deleteWatchlist(id: number): Promise<void>;

  // Backtest
  getBacktestRecords(horizon?: number): Promise<BacktestRecord[]>;
  getBacktestStats(): Promise<BacktestStats>;

  // Refresh log
  logRefresh(data: Omit<RefreshLog, "id">): Promise<void>;
  getLastRefresh(): Promise<RefreshLog | null>;
  getRefreshHistory(limit?: number): Promise<RefreshLog[]>;

  // Settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  // Opportunity Scores (independent of Buy/Watch/Avoid)
  saveOpportunityScore(score: import('./lib/opportunityEngine').OpportunityResult, snapshotId?: number): Promise<void>;
  getOpportunityScores(filters?: OpportunityFilters): Promise<OpportunityScoreRow[]>;

  // Universe name backfill
  updateUniverseName(ticker: string, name: string): Promise<void>;
  updateUniverseSector(ticker: string, sector: string): Promise<void>;

  // Invite tokens (auth)
  getInviteToken(token: string): Promise<InviteToken | null>;
  getAllInviteTokens(): Promise<InviteToken[]>;
  createInviteToken(label: string): Promise<InviteToken>;
  revokeInviteToken(token: string): Promise<void>;
  touchInviteToken(token: string): Promise<void>;

  // Access links (two-tier auth)
  getAccessLink(id: string): Promise<AccessLink | null>;
  getAllAccessLinks(): Promise<AccessLink[]>;
  createAccessLink(id: string, label: string, type: 'admin' | 'viewer'): Promise<AccessLink>;
  revokeAccessLink(id: string): Promise<void>;
  touchAccessLink(id: string): Promise<void>;
  accessLinkCount(): number;

  // Failed stocks tracking
  recordFailedStock(ticker: string, error: string, category: string): Promise<void>;
  resetConsecutiveFails(ticker: string): Promise<void>;
  getConsecutiveFails(ticker: string): Promise<number>;
  getFailedStocks(): Promise<FailedStock[]>;
  flagAutoRemoved(ticker: string, reason: string): Promise<void>;
  clearFailedStock(ticker: string): Promise<void>;
}

export interface OpportunityFilters {
  region?: string;
  themeTag?: string;
  minUpside?: number;
  maxRisk?: number;
  limit?: number;
}

export interface OpportunityScoreRow extends OpportunityScore {
  name?: string;
  sector?: string | null;
  industry?: string | null;
  region?: string;
  exchange?: string;
  country?: string;
  currency?: string;
}

export interface UniverseFilters {
  region?: string;
  exchange?: string;
  sector?: string;
  country?: string;
  assetType?: string;
  search?: string;
}

export interface RecommendationFilters {
  signal20d?: string;
  signal60d?: string;
  region?: string;
  exchange?: string;
  sector?: string;
  country?: string;
  assetType?: string;
  minScore?: number;
  maxScore?: number;
  watchlistId?: number;
}

export interface EnrichedRecommendation extends Recommendation {
  stockName: string;
  exchange: string;
  country: string;
  region: string;
  currency: string;
  sector: string | null;
  assetType: string;
  // From universe
  marketCap: number | null;
  // From latest snapshot
  price: number | null;
  changePct: number | null;
  volume: number | null;
  avgVolume20d: number | null;
  rsi14: number | null;
  dataFreshness: string;
  fetchedAt: string;
  // Fix #11A: coverage fields
  dataCoverage: number | null;
  coverageTier: string | null;
  sectorGroup: string | null;
}

export interface BacktestStats {
  totalRecords: number;
  byHorizon: {
    horizon: number;
    total: number;
    correct: number;
    accuracy: number;
    avgReturn: number;
    avgBenchmarkReturn: number;
    alpha: number;
  }[];
  bySignal: {
    signal: string;
    total: number;
    correct: number;
    accuracy: number;
  }[];
}

class StorageImpl implements IStorage {
  async getActiveUniverseStocks(): Promise<Universe[]> {
    return db.select().from(universe).where(eq(universe.isActive, true)).all();
  }

  async getUniverseItem(ticker: string): Promise<Universe | null> {
    return db.select().from(universe).where(eq(universe.ticker, ticker)).get() ?? null;
  }

  async getAllUniverseStocks(filters?: UniverseFilters): Promise<Universe[]> {
    let query = db.select().from(universe);
    const conditions = [];

    if (filters?.region) conditions.push(eq(universe.region, filters.region));
    if (filters?.exchange) conditions.push(eq(universe.exchange, filters.exchange));
    if (filters?.sector) conditions.push(eq(universe.sector, filters.sector));
    if (filters?.country) conditions.push(eq(universe.country, filters.country));
    if (filters?.assetType) conditions.push(eq(universe.assetType, filters.assetType));
    if (filters?.search) conditions.push(
      sql`(${universe.ticker} LIKE ${'%' + filters.search + '%'} OR ${universe.name} LIKE ${'%' + filters.search + '%'})`
    );

    if (conditions.length > 0) {
      return (query as any).where(and(...conditions)).all();
    }
    return query.all();
  }

  async addToUniverse(stock: InsertUniverse): Promise<Universe> {
    const existing = db.select().from(universe).where(eq(universe.ticker, stock.ticker)).get();
    if (existing) {
      // Reactivate if inactive
      db.update(universe).set({ isActive: true, ...stock }).where(eq(universe.ticker, stock.ticker)).run();
      return db.select().from(universe).where(eq(universe.ticker, stock.ticker)).get()!;
    }
    return db.insert(universe).values({ ...stock, addedAt: new Date().toISOString() }).returning().get();
  }

  async removeFromUniverse(ticker: string): Promise<void> {
    db.update(universe).set({ isActive: false }).where(eq(universe.ticker, ticker)).run();
  }

  async seedDefaultUniverse(): Promise<void> {
    for (const stock of DEFAULT_UNIVERSE) {
      const existing = db.select().from(universe).where(eq(universe.ticker, stock.ticker)).get();
      if (!existing) {
        db.insert(universe).values({ ...stock, addedAt: new Date().toISOString() }).run();
      }
    }
  }

  async saveSnapshot(raw: RawStockData): Promise<number> {
    // Opportunistically update universe.market_cap from fresh Yahoo data
    if (raw.marketCap != null) {
      try {
        sqlite.prepare(`UPDATE universe SET market_cap = ? WHERE ticker = ? AND (market_cap IS NULL OR market_cap = 0)`)
          .run(raw.marketCap, raw.ticker);
      } catch { /* non-fatal */ }
    }

    const result = db.insert(priceSnapshots).values({
      ticker: raw.ticker,
      fetchedAt: raw.fetchedAt,
      dataSource: raw.source,
      dataFreshness: raw.freshness,
      price: raw.price ?? null,
      open: raw.open ?? null,
      high: raw.high ?? null,
      low: raw.low ?? null,
      prevClose: raw.prevClose ?? null,
      change: raw.change ?? null,
      changePct: raw.changePct ?? null,
      volume: raw.volume ?? null,
      avgVolume20d: raw.avgVolume20d ?? null,
      sma20: raw.sma20 ?? null,
      sma50: raw.sma50 ?? null,
      sma200: raw.sma200 ?? null,
      ema12: raw.ema12 ?? null,
      ema26: raw.ema26 ?? null,
      rsi14: raw.rsi14 ?? null,
      macd: raw.macd ?? null,
      macdSignal: raw.macdSignal ?? null,
      atr14: raw.atr14 ?? null,
      beta: raw.beta ?? null,
      high52w: raw.high52w ?? null,
      low52w: raw.low52w ?? null,
      ret1d: raw.ret1d ?? null,
      ret5d: raw.ret5d ?? null,
      ret20d: raw.ret20d ?? null,
      ret60d: raw.ret60d ?? null,
      ret120d: raw.ret120d ?? null,
      ret250d: raw.ret250d ?? null,
      pe: raw.pe ?? null,
      pb: raw.pb ?? null,
      ps: raw.ps ?? null,
      evEbitda: raw.evEbitda ?? null,
      eps: raw.eps ?? null,
      epsGrowthYoy: raw.epsGrowthYoy ?? null,
      revenueGrowthYoy: raw.revenueGrowthYoy ?? null,
      grossMargin: raw.grossMargin ?? null,
      operatingMargin: raw.operatingMargin ?? null,
      roe: raw.roe ?? null,
      debtEquity: raw.debtEquity ?? null,
      freeCashFlow: raw.freeCashFlow ?? null,
      dividendYield: raw.dividendYield ?? null,
      shortPercentOfFloat: raw.shortPercentOfFloat ?? null,
      analystBuy: raw.analystBuy ?? null,
      analystHold: raw.analystHold ?? null,
      analystSell: raw.analystSell ?? null,
      priceTarget: raw.priceTarget ?? null,
      earningsDate: raw.earningsDate ?? null,
      sentimentScore: raw.sentimentScore ?? null,
      newsCount24h: raw.newsCount24h ?? null,
      nativeCurrency: raw.nativeCurrency ?? null,
      priceEur: raw.priceEur ?? null,
      priceUsd: raw.priceUsd ?? null,
      rawJson: raw.rawJson ?? null,
      errorMessage: raw.error ?? null,
    }).returning().get();
    return result.id;
  }

  async getLatestSnapshot(ticker: string): Promise<PriceSnapshot | null> {
    return db.select().from(priceSnapshots)
      .where(eq(priceSnapshots.ticker, ticker))
      .orderBy(desc(priceSnapshots.fetchedAt))
      .limit(1).get() ?? null;
  }

  async saveRecommendation(ranking: RankingResult, snapshotId: number): Promise<void> {
    // Upsert: one row per ticker, updated in-place. Prevents unbounded table growth.
    sqlite.prepare(`
      INSERT INTO recommendations
        (ticker, generated_at, snapshot_id,
         signal_20d, signal_60d, signal_120d, signal_250d,
         confidence_20d, confidence_60d, confidence_120d, confidence_250d,
         factor_momentum, factor_valuation, factor_quality,
         factor_earnings, factor_trend, factor_volatility, factor_sentiment,
         composite_score, risk_flags, explanation,
         data_coverage, coverage_tier, sector_group)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        generated_at   = excluded.generated_at,
        snapshot_id    = excluded.snapshot_id,
        signal_20d     = excluded.signal_20d,
        signal_60d     = excluded.signal_60d,
        signal_120d    = excluded.signal_120d,
        signal_250d    = excluded.signal_250d,
        confidence_20d = excluded.confidence_20d,
        confidence_60d = excluded.confidence_60d,
        confidence_120d = excluded.confidence_120d,
        confidence_250d = excluded.confidence_250d,
        factor_momentum   = excluded.factor_momentum,
        factor_valuation  = excluded.factor_valuation,
        factor_quality    = excluded.factor_quality,
        factor_earnings   = excluded.factor_earnings,
        factor_trend      = excluded.factor_trend,
        factor_volatility = excluded.factor_volatility,
        factor_sentiment  = excluded.factor_sentiment,
        composite_score   = excluded.composite_score,
        risk_flags        = excluded.risk_flags,
        explanation       = excluded.explanation,
        data_coverage     = excluded.data_coverage,
        coverage_tier     = excluded.coverage_tier,
        sector_group      = excluded.sector_group
    `).run(
      ranking.ticker,
      ranking.generatedAt,
      snapshotId,
      ranking.signals.d20.signal,
      ranking.signals.d60.signal,
      ranking.signals.d120.signal,
      ranking.signals.d250.signal,
      ranking.signals.d20.confidence,
      ranking.signals.d60.confidence,
      ranking.signals.d120.confidence,
      ranking.signals.d250.confidence,
      ranking.factors.momentum,
      ranking.factors.valuation,
      ranking.factors.quality,
      ranking.factors.earnings,
      ranking.factors.trend,
      ranking.factors.volatilityPenalty,
      ranking.factors.sentiment,
      ranking.compositeScore,
      JSON.stringify(ranking.riskFlags),
      ranking.explanation,
      ranking.dataCoverage ?? null,
      ranking.coverageTier ?? null,
      ranking.sectorGroup ?? null,
    );

    // Also save to backtest records
    const snap = await this.getLatestSnapshot(ranking.ticker);
    if (snap?.price) {
      db.insert(backtestRecords).values({
        ticker: ranking.ticker,
        signalDate: ranking.generatedAt,
        signal: ranking.signals.d60.signal,
        horizon: 60,
        compositeScore: ranking.compositeScore,
        entryPrice: snap.price,
        outcome: "pending",
      }).run();
      // Cap backtest_records at 10,000 rows (rolling window — not scoring input)
      sqlite.prepare(`
        DELETE FROM backtest_records
        WHERE id NOT IN (
          SELECT id FROM backtest_records ORDER BY id DESC LIMIT 10000
        )
      `).run();
    }
  }

  async getLatestRecommendations(filters?: RecommendationFilters): Promise<EnrichedRecommendation[]> {
    // Get latest recommendation per ticker via raw sqlite query
    const latestRecs = sqlite.prepare(`
      SELECT r.*, 
        u.name as stock_name, u.exchange, u.country, u.region, u.currency, u.sector, u.asset_type,
        u.market_cap,
        s.price, s.change_pct, s.volume, s.avg_volume_20d, s.rsi14, s.data_freshness, s.fetched_at,
        s.native_currency, s.price_eur, s.price_usd
      FROM recommendations r
      JOIN universe u ON r.ticker = u.ticker
      LEFT JOIN price_snapshots s ON s.id = r.snapshot_id
      WHERE r.id IN (
        SELECT MAX(id) FROM recommendations GROUP BY ticker
      )
      AND u.is_active = 1
      ORDER BY r.composite_score DESC
    `).all() as any[];

    return latestRecs.map((row: any) => ({
      id: row.id,
      ticker: row.ticker,
      generatedAt: row.generated_at,
      snapshotId: row.snapshot_id,
      signal20d: row.signal_20d,
      signal60d: row.signal_60d,
      signal120d: row.signal_120d,
      signal250d: row.signal_250d,
      confidence20d: row.confidence_20d,
      confidence60d: row.confidence_60d,
      confidence120d: row.confidence_120d,
      confidence250d: row.confidence_250d,
      factorMomentum: row.factor_momentum,
      factorTrend: row.factor_trend,
      factorEarnings: row.factor_earnings,
      factorValuation: row.factor_valuation,
      factorQuality: row.factor_quality,
      factorSentiment: row.factor_sentiment,
      factorVolatility: row.factor_volatility,
      compositeScore: row.composite_score,
      riskFlags: row.risk_flags,
      explanation: row.explanation,
      inputsHash: row.inputs_hash,
      // Enriched
      stockName: row.stock_name,
      exchange: row.exchange,
      country: row.country,
      region: row.region,
      currency: row.currency,
      sector: row.sector,
      assetType: row.asset_type,
      marketCap: row.market_cap ?? null,
      price: row.price,
      changePct: row.change_pct,
      volume: row.volume,
      avgVolume20d: row.avg_volume_20d ?? null,
      rsi14: row.rsi14,
      dataFreshness: row.data_freshness || "unknown",
      fetchedAt: row.fetched_at || row.generated_at,
      nativeCurrency: row.native_currency ?? null,
      priceEur: row.price_eur ?? null,
      priceUsd: row.price_usd ?? null,
      // Fix #11A: coverage fields
      dataCoverage: row.data_coverage ?? null,
      coverageTier: row.coverage_tier ?? null,
      sectorGroup: row.sector_group ?? null,
    }));
  }

  async getLatestRecommendationForTicker(ticker: string): Promise<Recommendation | null> {
    return db.select().from(recommendations)
      .where(eq(recommendations.ticker, ticker))
      .orderBy(desc(recommendations.generatedAt))
      .limit(1).get() ?? null;
  }

  async getRecommendationHistory(ticker: string, limit = 20): Promise<Recommendation[]> {
    return db.select().from(recommendations)
      .where(eq(recommendations.ticker, ticker))
      .orderBy(desc(recommendations.generatedAt))
      .limit(limit).all();
  }

  async getWatchlists(): Promise<Watchlist[]> {
    return db.select().from(watchlists).all();
  }

  async createWatchlist(data: InsertWatchlist): Promise<Watchlist> {
    return db.insert(watchlists).values({ ...data, createdAt: new Date().toISOString() }).returning().get();
  }

  async updateWatchlist(id: number, data: Partial<InsertWatchlist>): Promise<Watchlist | null> {
    db.update(watchlists).set(data).where(eq(watchlists.id, id)).run();
    return db.select().from(watchlists).where(eq(watchlists.id, id)).get() ?? null;
  }

  async deleteWatchlist(id: number): Promise<void> {
    db.delete(watchlists).where(eq(watchlists.id, id)).run();
  }

  async getBacktestRecords(horizon?: number): Promise<BacktestRecord[]> {
    if (horizon) {
      return db.select().from(backtestRecords).where(eq(backtestRecords.horizon, horizon)).all();
    }
    return db.select().from(backtestRecords).orderBy(desc(backtestRecords.signalDate)).limit(500).all();
  }

  async getBacktestStats(): Promise<BacktestStats> {
    const records = await this.getBacktestRecords();
    const evaluated = records.filter((r) => r.outcome !== "pending");
    const horizons = [20, 60, 120, 250];

    const byHorizon = horizons.map((h) => {
      const hRecs = evaluated.filter((r) => r.horizon === h);
      const correct = hRecs.filter((r) => r.outcome === "correct").length;
      const avgReturn = hRecs.length > 0
        ? hRecs.reduce((a, b) => a + (b.actualReturn ?? 0), 0) / hRecs.length
        : 0;
      const avgBenchmark = hRecs.length > 0
        ? hRecs.reduce((a, b) => a + (b.benchmarkReturn ?? 0), 0) / hRecs.length
        : 0;
      return {
        horizon: h,
        total: hRecs.length,
        correct,
        accuracy: hRecs.length > 0 ? (correct / hRecs.length) * 100 : 0,
        avgReturn,
        avgBenchmarkReturn: avgBenchmark,
        alpha: avgReturn - avgBenchmark,
      };
    });

    const signals = ["buy", "watch", "avoid"];
    const bySignal = signals.map((s) => {
      const sRecs = evaluated.filter((r) => r.signal === s);
      const correct = sRecs.filter((r) => r.outcome === "correct").length;
      return {
        signal: s,
        total: sRecs.length,
        correct,
        accuracy: sRecs.length > 0 ? (correct / sRecs.length) * 100 : 0,
      };
    });

    return { totalRecords: records.length, byHorizon, bySignal };
  }

  async logRefresh(data: Omit<RefreshLog, "id">): Promise<void> {
    db.insert(refreshLog).values(data).run();
    // Cap refresh_log at 500 rows (pure audit log, no scoring dependency)
    sqlite.prepare(`
      DELETE FROM refresh_log
      WHERE id NOT IN (
        SELECT id FROM refresh_log ORDER BY id DESC LIMIT 500
      )
    `).run();
  }

  async getLastRefresh(): Promise<RefreshLog | null> {
    return db.select().from(refreshLog).orderBy(desc(refreshLog.startedAt)).limit(1).get() ?? null;
  }

  async getRefreshHistory(limit = 20): Promise<RefreshLog[]> {
    return db.select().from(refreshLog).orderBy(desc(refreshLog.startedAt)).limit(limit).all();
  }

  async getSetting(key: string): Promise<string | null> {
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    if (existing) {
      db.update(settings).set({ value, updatedAt: new Date().toISOString() }).where(eq(settings.key, key)).run();
    } else {
      db.insert(settings).values({ key, value, updatedAt: new Date().toISOString() }).run();
    }
  }

  // ─── Opportunity Scores ─────────────────────────────────────────────────────
  async saveOpportunityScore(
    score: import('./lib/opportunityEngine').OpportunityResult,
    snapshotId?: number
  ): Promise<void> {
    // Use raw sqlite for upsert to avoid Drizzle schema mismatch with old columns
    const stmt = sqlite.prepare(`
      INSERT INTO opportunity_scores (
        ticker, computed_at, upside_score, risk_score,
        raw_analyst_upside_pct, raw_52w_high_upside_pct, raw_revenue_growth_pct, raw_eps_growth_pct,
        raw_drawdown_risk_pct, raw_atr_pct, raw_beta, raw_debt_equity, thematic_multiplier,
        upside_analyst_target, upside_52w_high, upside_revenue_growth, upside_eps_growth,
        upside_valuation_rerating,
        risk_drawdown, risk_atr, risk_beta, risk_debt_equity,
        theme_tags, horizon_scores, snapshot_id
      ) VALUES (
        @ticker, @computedAt, @upsideScore, @riskScore,
        @rawAnalystUpsidePct, @raw52wHighUpsidePct, @rawRevenueGrowthPct, @rawEpsGrowthPct,
        @rawDrawdownRiskPct, @rawAtrPct, @rawBeta, @rawDebtEquity, @thematicMultiplier,
        @upsideAnalystTarget, @upside52wHigh, @upsideRevenueGrowth, @upsideEpsGrowth,
        @upsideValuationRerating,
        @riskDrawdown, @riskAtr, @riskBeta, @riskDebtEquity,
        @themeTags, @horizonScores, @snapshotId
      )
      ON CONFLICT(ticker) DO UPDATE SET
        computed_at = excluded.computed_at,
        upside_score = excluded.upside_score,
        risk_score = excluded.risk_score,
        raw_analyst_upside_pct = excluded.raw_analyst_upside_pct,
        raw_52w_high_upside_pct = excluded.raw_52w_high_upside_pct,
        raw_revenue_growth_pct = excluded.raw_revenue_growth_pct,
        raw_eps_growth_pct = excluded.raw_eps_growth_pct,
        raw_drawdown_risk_pct = excluded.raw_drawdown_risk_pct,
        raw_atr_pct = excluded.raw_atr_pct,
        raw_beta = excluded.raw_beta,
        raw_debt_equity = excluded.raw_debt_equity,
        thematic_multiplier = excluded.thematic_multiplier,
        upside_analyst_target = excluded.upside_analyst_target,
        upside_52w_high = excluded.upside_52w_high,
        upside_revenue_growth = excluded.upside_revenue_growth,
        upside_eps_growth = excluded.upside_eps_growth,
        upside_valuation_rerating = excluded.upside_valuation_rerating,
        risk_drawdown = excluded.risk_drawdown,
        risk_atr = excluded.risk_atr,
        risk_beta = excluded.risk_beta,
        risk_debt_equity = excluded.risk_debt_equity,
        theme_tags = excluded.theme_tags,
        horizon_scores = excluded.horizon_scores,
        snapshot_id = excluded.snapshot_id
    `);

    stmt.run({
      ticker: score.ticker,
      computedAt: score.computedAt,
      upsideScore: score.upsideScore ?? null,
      riskScore: score.riskScore ?? null,
      rawAnalystUpsidePct: score.rawAnalystUpsidePct ?? null,
      raw52wHighUpsidePct: score.raw52wHighUpsidePct ?? null,
      rawRevenueGrowthPct: score.rawRevenueGrowthPct ?? null,
      rawEpsGrowthPct: score.rawEpsGrowthPct ?? null,
      rawDrawdownRiskPct: score.rawDrawdownRiskPct ?? null,
      rawAtrPct: score.rawAtrPct ?? null,
      rawBeta: score.rawBeta ?? null,
      rawDebtEquity: score.rawDebtEquity ?? null,
      thematicMultiplier: score.thematicMultiplier ?? null,
      upsideAnalystTarget: score.upsideAnalystTarget ?? null,
      upside52wHigh: score.upside52wHigh ?? null,
      upsideRevenueGrowth: score.upsideRevenueGrowth ?? null,
      upsideEpsGrowth: score.upsideEpsGrowth ?? null,
      upsideValuationRerating: score.upsideValuationRerating ?? null,
      riskDrawdown: score.riskDrawdown ?? null,
      riskAtr: score.riskAtr ?? null,
      riskBeta: score.riskBeta ?? null,
      riskDebtEquity: score.riskDebtEquity ?? null,
      themeTags: JSON.stringify(score.themeTags),
      horizonScores: JSON.stringify(score.horizonScores),
      snapshotId: snapshotId ?? null,
    });
  }

  async getOpportunityScores(filters?: import('./storage').OpportunityFilters): Promise<OpportunityScoreRow[]> {
    // Use raw SQL to avoid Drizzle schema mismatch with evolving opportunity_scores columns
    const rawScores = sqlite.prepare(`
      SELECT o.*,
        u.name, u.sector, u.industry, u.region, u.exchange, u.country, u.currency
      FROM opportunity_scores o
      LEFT JOIN universe u ON o.ticker = u.ticker
    `).all() as any[];

    let rows: OpportunityScoreRow[] = rawScores.map((s: any) => ({
      // Map raw columns to typed fields
      id: s.id,
      ticker: s.ticker,
      computedAt: s.computed_at,
      upsideScore: s.upside_score ?? null,
      riskScore: s.risk_score ?? null,
      rawAnalystUpsidePct: s.raw_analyst_upside_pct ?? null,
      raw52wHighUpsidePct: s.raw_52w_high_upside_pct ?? null,
      rawRevenueGrowthPct: s.raw_revenue_growth_pct ?? null,
      rawEpsGrowthPct: s.raw_eps_growth_pct ?? null,
      rawDrawdownRiskPct: s.raw_drawdown_risk_pct ?? null,
      rawAtrPct: s.raw_atr_pct ?? null,
      rawBeta: s.raw_beta ?? null,
      rawDebtEquity: s.raw_debt_equity ?? null,
      thematicMultiplier: s.thematic_multiplier ?? null,
      upsideAnalystTarget: s.upside_analyst_target ?? null,
      upside52wHigh: s.upside_52w_high ?? null,
      upsideRevenueGrowth: s.upside_revenue_growth ?? null,
      upsideEpsGrowth: s.upside_eps_growth ?? null,
      upsideValuationRerating: s.upside_valuation_rerating ?? null,
      riskDrawdown: s.risk_drawdown ?? null,
      riskAtr: s.risk_atr ?? null,
      riskBeta: s.risk_beta ?? null,
      riskDebtEquity: s.risk_debt_equity ?? null,
      themeTags: s.theme_tags ?? '[]',
      horizonScores: s.horizon_scores ?? '{}',
      snapshotId: s.snapshot_id ?? null,
      // Universe metadata
      name: s.name ?? undefined,
      sector: s.sector ?? null,
      industry: s.industry ?? null,
      region: s.region ?? undefined,
      exchange: s.exchange ?? undefined,
      country: s.country ?? undefined,
      currency: s.currency ?? undefined,
    }));

    if (filters?.region && filters.region !== 'All') {
      rows = rows.filter((r) => r.region === filters.region);
    }
    if (filters?.themeTag) {
      rows = rows.filter((r) => {
        try { return (JSON.parse(r.themeTags) as string[]).includes(filters.themeTag!); }
        catch { return false; }
      });
    }
    if (filters?.minUpside != null) {
      rows = rows.filter((r) => (r.upsideScore ?? 0) >= filters.minUpside!);
    }
    if (filters?.maxRisk != null) {
      rows = rows.filter((r) => (r.riskScore ?? 100) <= filters.maxRisk!);
    }

    // Sort by upside descending by default
    rows.sort((a, b) => (b.upsideScore ?? 0) - (a.upsideScore ?? 0));

    if (filters?.limit) {
      rows = rows.slice(0, filters.limit);
    }

    return rows;
  }
  // ─── Universe name backfill ──────────────────────────────────────────────────────
  async updateUniverseName(ticker: string, name: string): Promise<void> {
    sqlite.prepare("UPDATE universe SET name = ? WHERE ticker = ?").run(name, ticker);
  }

  // ─── Universe sector update ──────────────────────────────────────────────────────
  async updateUniverseSector(ticker: string, sector: string): Promise<void> {
    sqlite.prepare("UPDATE universe SET sector = ? WHERE ticker = ?").run(sector, ticker);
  }

  // ─── Invite Tokens ──────────────────────────────────────────────────────────────
  async getInviteToken(token: string): Promise<InviteToken | null> {
    const row = sqlite.prepare(
      "SELECT * FROM invite_tokens WHERE token = ? AND is_active = 1"
    ).get(token) as any;
    if (!row) return null;
    return { id: row.id, token: row.token, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at, isActive: !!row.is_active };
  }

  async getAllInviteTokens(): Promise<InviteToken[]> {
    const rows = sqlite.prepare("SELECT * FROM invite_tokens ORDER BY created_at DESC").all() as any[];
    return rows.map((row: any) => ({ id: row.id, token: row.token, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at, isActive: !!row.is_active }));
  }

  async createInviteToken(label: string): Promise<InviteToken> {
    const { randomBytes } = await import('crypto');
    const token = randomBytes(24).toString('hex');
    const now = new Date().toISOString();
    sqlite.prepare(
      "INSERT INTO invite_tokens (token, label, created_at, is_active) VALUES (?, ?, ?, 1)"
    ).run(token, label, now);
    return { id: (sqlite.prepare("SELECT last_insert_rowid() as id").get() as any).id, token, label, createdAt: now, lastUsedAt: null, isActive: true };
  }

  async revokeInviteToken(token: string): Promise<void> {
    sqlite.prepare("UPDATE invite_tokens SET is_active = 0 WHERE token = ?").run(token);
  }

  async touchInviteToken(token: string): Promise<void> {
    sqlite.prepare("UPDATE invite_tokens SET last_used_at = ? WHERE token = ?").run(new Date().toISOString(), token);
  }

  // ─── Access Links ──────────────────────────────────────────────────────────
  async getAccessLink(id: string): Promise<AccessLink | null> {
    const row = sqlite.prepare("SELECT * FROM access_links WHERE id = ?").get(id) as any;
    if (!row) return null;
    return { id: row.id, label: row.label, type: row.type, createdAt: row.created_at, lastUsedAt: row.last_used_at, isActive: !!row.is_active };
  }

  async getAllAccessLinks(): Promise<AccessLink[]> {
    const rows = sqlite.prepare("SELECT * FROM access_links ORDER BY created_at DESC").all() as any[];
    return rows.map((row: any) => ({ id: row.id, label: row.label, type: row.type, createdAt: row.created_at, lastUsedAt: row.last_used_at, isActive: !!row.is_active }));
  }

  async createAccessLink(id: string, label: string, type: 'admin' | 'viewer'): Promise<AccessLink> {
    const now = new Date().toISOString();
    sqlite.prepare("INSERT INTO access_links (id, label, type, created_at, is_active) VALUES (?, ?, ?, ?, 1)").run(id, label, type, now);
    return { id, label, type, createdAt: now, lastUsedAt: null, isActive: true };
  }

  async revokeAccessLink(id: string): Promise<void> {
    sqlite.prepare("UPDATE access_links SET is_active = 0 WHERE id = ?").run(id);
  }

  touchAccessLink(id: string): void {
    // Best-effort, non-blocking — never throws
    try {
      sqlite.prepare("UPDATE access_links SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    } catch { /* non-fatal */ }
  }

  accessLinkCount(): number {
    const row = sqlite.prepare("SELECT COUNT(*) AS c FROM access_links WHERE is_active = 1").get() as any;
    return row?.c ?? 0;
  }

  // ─── Failed Stocks ──────────────────────────────────────────────────────────────
  async recordFailedStock(ticker: string, error: string, category: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = sqlite.prepare("SELECT * FROM failed_stocks WHERE ticker = ?").get(ticker) as any;
    if (existing) {
      sqlite.prepare(
        "UPDATE failed_stocks SET last_error = ?, error_category = ?, consecutive_fails = consecutive_fails + 1, last_failed_at = ? WHERE ticker = ?"
      ).run(error, category, now, ticker);
    } else {
      sqlite.prepare(
        "INSERT INTO failed_stocks (ticker, last_error, error_category, consecutive_fails, first_failed_at, last_failed_at) VALUES (?, ?, ?, 1, ?, ?)"
      ).run(ticker, error, category, now, now);
    }
  }

  async resetConsecutiveFails(ticker: string): Promise<void> {
    sqlite.prepare(
      "DELETE FROM failed_stocks WHERE ticker = ? AND auto_removed = 0"
    ).run(ticker);
  }

  async getConsecutiveFails(ticker: string): Promise<number> {
    const row = sqlite.prepare("SELECT consecutive_fails FROM failed_stocks WHERE ticker = ?").get(ticker) as any;
    return row?.consecutive_fails ?? 0;
  }

  async getFailedStocks(): Promise<FailedStock[]> {
    const rows = sqlite.prepare("SELECT * FROM failed_stocks ORDER BY last_failed_at DESC").all() as any[];
    return rows.map((row: any) => ({
      id: row.id,
      ticker: row.ticker,
      lastError: row.last_error,
      errorCategory: row.error_category,
      consecutiveFails: row.consecutive_fails,
      firstFailedAt: row.first_failed_at,
      lastFailedAt: row.last_failed_at,
      autoRemoved: !!row.auto_removed,
      autoRemovedReason: row.auto_removed_reason,
    }));
  }

  async flagAutoRemoved(ticker: string, reason: string): Promise<void> {
    sqlite.prepare(
      "UPDATE failed_stocks SET auto_removed = 1, auto_removed_reason = ? WHERE ticker = ?"
    ).run(reason, ticker);
  }

  async clearFailedStock(ticker: string): Promise<void> {
    sqlite.prepare("DELETE FROM failed_stocks WHERE ticker = ?").run(ticker);
  }
}

export const storage = new StorageImpl();

// Seed default universe on startup
storage.seedDefaultUniverse().catch(console.error);
