import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Universe: global stock universe ────────────────────────────────────────
export const universe = sqliteTable("universe", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  name: text("name").notNull(),
  exchange: text("exchange").notNull(), // NYSE, NASDAQ, XETRA, LSE, EURONEXT, etc.
  country: text("country").notNull(),
  region: text("region").notNull(), // US, Europe, Asia
  currency: text("currency").notNull(),
  sector: text("sector"),
  industry: text("industry"),
  marketCap: real("market_cap"), // USD, latest known
  assetType: text("asset_type").notNull().default("stock"), // stock | etf
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  addedAt: text("added_at").notNull().default(new Date().toISOString()),
});

export const insertUniverseSchema = createInsertSchema(universe).omit({
  id: true,
  addedAt: true,
});
export type InsertUniverse = z.infer<typeof insertUniverseSchema>;
export type Universe = typeof universe.$inferSelect;

// ─── Watchlists ──────────────────────────────────────────────────────────────
export const watchlists = sqliteTable("watchlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  tickers: text("tickers").notNull().default("[]"), // JSON array
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});

export const insertWatchlistSchema = createInsertSchema(watchlists).omit({
  id: true,
  createdAt: true,
});
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type Watchlist = typeof watchlists.$inferSelect;

// ─── Price Snapshots: raw fetched data ───────────────────────────────────────
export const priceSnapshots = sqliteTable("price_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  dataSource: text("data_source").notNull(), // yahoo | alphavantage | eod
  dataFreshness: text("data_freshness").notNull(), // realtime | delayed | eod
  // Price
  price: real("price"),
  open: real("open"),
  high: real("high"),
  low: real("low"),
  prevClose: real("prev_close"),
  change: real("change"),
  changePct: real("change_pct"),
  volume: integer("volume"),
  avgVolume20d: integer("avg_volume_20d"),
  // Technicals
  sma20: real("sma20"),
  sma50: real("sma50"),
  sma200: real("sma200"),
  ema12: real("ema12"),
  ema26: real("ema26"),
  rsi14: real("rsi14"),
  macd: real("macd"),
  macdSignal: real("macd_signal"),
  atr14: real("atr14"),
  beta: real("beta"),
  // 52-week
  high52w: real("high_52w"),
  low52w: real("low_52w"),
  // Returns
  ret1d: real("ret_1d"),
  ret5d: real("ret_5d"),
  ret20d: real("ret_20d"),
  ret60d: real("ret_60d"),
  ret120d: real("ret_120d"),
  ret250d: real("ret_250d"),
  // Fundamentals
  pe: real("pe"),
  pb: real("pb"),
  ps: real("ps"),
  evEbitda: real("ev_ebitda"),
  eps: real("eps"),
  epsGrowthYoy: real("eps_growth_yoy"),
  revenueGrowthYoy: real("revenue_growth_yoy"),
  grossMargin: real("gross_margin"),
  operatingMargin: real("operating_margin"),
  roe: real("roe"),
  debtEquity: real("debt_equity"),
  freeCashFlow: real("free_cash_flow"),
  dividendYield: real("dividend_yield"),
  shortPercentOfFloat: real("short_percent_of_float"),
  // Analyst
  analystBuy: integer("analyst_buy"),
  analystHold: integer("analyst_hold"),
  analystSell: integer("analyst_sell"),
  priceTarget: real("price_target"),
  earningsDate: text("earnings_date"),
  // News/Sentiment (0-1 scale, model-derived)
  sentimentScore: real("sentiment_score"),
  newsCount24h: integer("news_count_24h"),
  // FX-converted prices (added in migration v4)
  nativeCurrency: text("native_currency"),   // raw Yahoo currency code e.g. KRW, JPY, GBp
  priceEur: real("price_eur"),               // price converted to EUR
  priceUsd: real("price_usd"),               // price converted to USD
  // Raw JSON for audit
  rawJson: text("raw_json"),
  errorMessage: text("error_message"),
});

export type PriceSnapshot = typeof priceSnapshots.$inferSelect;

// ─── Recommendations ─────────────────────────────────────────────────────────
export const recommendations = sqliteTable("recommendations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  generatedAt: text("generated_at").notNull(),
  snapshotId: integer("snapshot_id"),
  // Signal for each horizon
  signal20d: text("signal_20d"), // buy | watch | avoid
  signal60d: text("signal_60d"),
  signal120d: text("signal_120d"),
  signal250d: text("signal_250d"),
  // Confidence 0-100
  confidence20d: real("confidence_20d"),
  confidence60d: real("confidence_60d"),
  confidence120d: real("confidence_120d"),
  confidence250d: real("confidence_250d"),
  // Factor scores (0-100)
  factorMomentum: real("factor_momentum"),
  factorValuation: real("factor_valuation"),
  factorQuality: real("factor_quality"),
  factorEarnings: real("factor_earnings"),
  factorTrend: real("factor_trend"),
  factorVolatility: real("factor_volatility"),
  factorSentiment: real("factor_sentiment"),
  // Composite score
  compositeScore: real("composite_score"),
  // Flags (JSON array of strings)
  riskFlags: text("risk_flags").default("[]"),
  // Human-readable explanation
  explanation: text("explanation"),
  // Model inputs fingerprint (for audit)
  inputsHash: text("inputs_hash"),
  // Fix #11A: data coverage
  dataCoverage: real("data_coverage"),        // 0-100 % coverage of core fields
  coverageTier: text("coverage_tier"),         // high | medium | low
  sectorGroup: text("sector_group"),           // resolved sector group
});

export const insertRecommendationSchema = createInsertSchema(recommendations).omit({ id: true });
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type Recommendation = typeof recommendations.$inferSelect;

// ─── Backtest Records ─────────────────────────────────────────────────────────
export const backtestRecords = sqliteTable("backtest_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  signalDate: text("signal_date").notNull(),
  signal: text("signal").notNull(), // buy | watch | avoid
  horizon: integer("horizon").notNull(), // 20 | 60 | 120 | 250
  compositeScore: real("composite_score"),
  entryPrice: real("entry_price"),
  exitPrice: real("exit_price"),
  actualReturn: real("actual_return"),
  benchmarkReturn: real("benchmark_return"), // vs SPY or MSCI World
  outcome: text("outcome"), // correct | incorrect | pending
  evaluatedAt: text("evaluated_at"),
});

export type BacktestRecord = typeof backtestRecords.$inferSelect;

// ─── Refresh Log ──────────────────────────────────────────────────────────────
export const refreshLog = sqliteTable("refresh_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  tickersAttempted: integer("tickers_attempted").default(0),
  tickersSucceeded: integer("tickers_succeeded").default(0),
  tickersFailed: integer("tickers_failed").default(0),
  triggerType: text("trigger_type").notNull().default("manual"), // manual | scheduled
  intervalMinutes: integer("interval_minutes"),
  notes: text("notes"),
});

export type RefreshLog = typeof refreshLog.$inferSelect;

// ─── Opportunity Scores v2 (100% independent of Buy/Watch/Avoid scoring) ─────
export const opportunityScores = sqliteTable("opportunity_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  computedAt: text("computed_at").notNull(),

  // --- Composite scores (default 3y horizon, 0-100) ---
  upsideScore: real("upside_score"),
  riskScore: real("risk_score"),

  // --- Raw absolute values (actual % values for display in tooltips/sub-rows) ---
  rawAnalystUpsidePct: real("raw_analyst_upside_pct"),   // e.g. +47.3
  raw52wHighUpsidePct: real("raw_52w_high_upside_pct"),  // e.g. +18.2
  rawRevenueGrowthPct: real("raw_revenue_growth_pct"),   // e.g. +22.5
  rawEpsGrowthPct:     real("raw_eps_growth_pct"),        // e.g. +31.0
  rawDrawdownRiskPct:  real("raw_drawdown_risk_pct"),     // e.g. 34.5 (% drop to 52w low)
  rawAtrPct:           real("raw_atr_pct"),               // e.g. 2.4 (ATR as % of price)
  rawBeta:             real("raw_beta"),                  // e.g. 1.35
  rawDebtEquity:       real("raw_debt_equity"),           // e.g. 0.82
  thematicMultiplier:  real("thematic_multiplier"),       // 1.0–1.5

  // --- Normalised component scores (0-100) ---
  upsideAnalystTarget: real("upside_analyst_target"),
  upside52wHigh:       real("upside_52w_high"),
  upsideRevenueGrowth: real("upside_revenue_growth"),
  upsideEpsGrowth:     real("upside_eps_growth"),
  upsideValuationRerating: real("upside_valuation_rerating"),
  riskDrawdown:        real("risk_drawdown"),
  riskAtr:             real("risk_atr"),
  riskBeta:            real("risk_beta"),
  riskDebtEquity:      real("risk_debt_equity"),

  // --- Theme tags (JSON array of theme names) ---
  themeTags: text("theme_tags").notNull().default("[]"),

  // --- Horizon scores (JSON: {"1y":{upsideScore,riskScore,compositeScore}, "3y":{...}, ...}) ---
  horizonScores: text("horizon_scores").notNull().default("{}"),

  // Snapshot ref
  snapshotId: integer("snapshot_id"),
});

export const insertOpportunityScoreSchema = createInsertSchema(opportunityScores).omit({ id: true });
export type InsertOpportunityScore = z.infer<typeof insertOpportunityScoreSchema>;
export type OpportunityScore = typeof opportunityScores.$inferSelect;

// ─── Settings ─────────────────────────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

export type Setting = typeof settings.$inferSelect;

// ─── Invite Tokens (auth) ─────────────────────────────────────────────────────
export const inviteTokens = sqliteTable("invite_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  label: text("label").notNull().default(""),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  lastUsedAt: text("last_used_at"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type InviteToken = typeof inviteTokens.$inferSelect;

// ─── Access Links (two-tier access control) ──────────────────────────────────────────
export const accessLinks = sqliteTable("access_links", {
  id: text("id").primaryKey(),
  label: text("label").notNull().default(""),
  type: text("type").notNull().default("viewer"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  lastUsedAt: text("last_used_at"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export type AccessLink = typeof accessLinks.$inferSelect;

// ─── Failed Stocks ─────────────────────────────────────────────────────────────
export const failedStocks = sqliteTable("failed_stocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  lastError: text("last_error").notNull(),
  errorCategory: text("error_category").notNull().default("unknown"), // rate_limited | not_found | missing_price | network_timeout | unknown
  consecutiveFails: integer("consecutive_fails").notNull().default(1),
  firstFailedAt: text("first_failed_at").notNull(),
  lastFailedAt: text("last_failed_at").notNull(),
  autoRemoved: integer("auto_removed", { mode: "boolean" }).notNull().default(false),
  autoRemovedReason: text("auto_removed_reason"),
});

export type FailedStock = typeof failedStocks.$inferSelect;

// ─── Insider Transactions ─────────────────────────────────────────────────────
export const insiderTransactions = sqliteTable("insider_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  filedAt: text("filed_at"),           // ISO date string from Yahoo
  transactionDate: text("transaction_date"),
  insiderName: text("insider_name"),
  relation: text("relation"),          // e.g. "Officer", "Director"
  transactionType: text("transaction_type"), // "Buy" | "Sale" | "Option Exercise" etc.
  shares: real("shares"),
  value: real("value"),               // USD
  fetchedAt: text("fetched_at").notNull(),
});

export type InsiderTransaction = typeof insiderTransactions.$inferSelect;
