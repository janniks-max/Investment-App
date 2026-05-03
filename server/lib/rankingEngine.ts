/**
 * Ranking Engine — Horizon-Specific Interpretable Factor Model
 *
 * Each horizon (20d / 60d / 120d / 250d) has:
 *   - Distinct factor weights
 *   - Distinct risk penalty multipliers
 *   - Distinct confidence calibration
 *   - Distinct explanation language
 *
 * IMPORTANT DISCLAIMERS:
 * - This is a probabilistic research model, NOT financial advice.
 * - Outputs are model opinions, not facts about future prices.
 * - All predictions are labeled as model outputs in the UI.
 *
 * Labeling: RANKING-BASED PERCENTILE BUCKETING
 *   Labels are assigned after ranking the universe by horizon-adjusted score.
 *   Thresholds scale with strictness: Conservative / Balanced / Opportunistic.
 */

import { RawStockData } from "./dataFetcher";
import {
  resolveSectorGroup,
  applyExclusions,
  passesBuyGate,
  getSectorNote,
  SECTOR_RULES,
  type SectorGroup,
} from "./sectorRules";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FactorBreakdown {
  momentum: number | null;           // 0-100: recent return strength
  trend: number | null;              // 0-100: price vs moving averages
  earnings: number | null;           // 0-100: EPS growth + analyst direction
  valuation: number | null;          // 0-100: PE/PB/EVEBITDA (higher = cheaper)
  quality: number | null;            // 0-100: margins, ROE, FCF, debt
  sentiment: number | null;          // 0-100: analyst ratings, volume, news
  volatilityPenalty: number | null;  // 0-100 (higher = more volatile = penalty)
}

export interface HorizonWeights {
  momentum: number;
  trend: number;
  earnings: number;
  valuation: number;
  quality: number;
  sentiment: number;
  volatilityPenaltyMultiplier: number; // how aggressively vol penalizes score
  label: string;
  targetDescription: string;
}

export interface HorizonSignal {
  signal: "buy" | "watch" | "avoid";
  confidence: number;             // 0-100
  compositeScore: number;         // 0-100 (horizon-specific weighted score)
  rank?: number;                  // 1-based within universe
  percentile?: number;            // 0-100 (100 = best)
  explanation?: string;           // horizon-specific explanation
  factorWeights?: HorizonWeights; // weights used to produce this score
}

// ─── Coverage Tier ───────────────────────────────────────────────────────────
// Derived from data coverage score (0-100 %).
//   High   ≥ 75 % → Buy allowed
//   Medium ≥ 50 % → Watch/Buy allowed, no Strong-percentile buy
//   Low    < 50 % → capped at Watch
export type CoverageTier = "high" | "medium" | "low";

export interface RankingResult {
  ticker: string;
  generatedAt: string;
  factors: FactorBreakdown;
  compositeScore: number;  // base (60d score) stored in DB
  signals: {
    d20: HorizonSignal;
    d60: HorizonSignal;
    d120: HorizonSignal;
    d250: HorizonSignal;
  };
  riskFlags: string[];
  explanation: string;     // 60d-based for DB storage
  dataAvailability: number; // legacy: factorsUsed / 6
  // ── Fix #11A additions ──
  dataCoverage: number;    // 0-100 %: coverage of core fields (see CORE_FIELDS)
  coverageTier: CoverageTier;
  sectorGroup: string;     // resolved sector group label
  sectorNote: string;      // human-readable sector adjustment note
}

export interface StrictnessConfig {
  buyTopPct: number;
  watchPct: number;
}

// ─── Strictness Presets ───────────────────────────────────────────────────────

export const STRICTNESS_PRESETS: Record<string, StrictnessConfig> = {
  conservative:  { buyTopPct: 10, watchPct: 20 },
  balanced:      { buyTopPct: 15, watchPct: 25 },
  opportunistic: { buyTopPct: 25, watchPct: 30 },
};

// ─── Horizon Weight Profiles ──────────────────────────────────────────────────
// Weights sum to 1.0 per horizon. Each horizon is genuinely distinct.
// 20d: momentum/trend dominate; high vol penalty
// 60d: balanced earnings + momentum; moderate vol penalty
// 120d: quality + valuation rise; low vol sensitivity
// 250d: valuation + quality dominate; minimal vol penalty

export const HORIZON_WEIGHTS: Record<string, HorizonWeights> = {
  "20": {
    momentum:  0.35,
    trend:     0.25,
    earnings:  0.20,
    valuation: 0.08,
    quality:   0.07,
    sentiment: 0.05,
    volatilityPenaltyMultiplier: 0.35,
    label: "20d: Momentum & catalyst",
    targetDescription: "Near-term (4-week) relative return. Momentum and trend dominate; earnings catalysts matter; valuation is minor. High penalty for volatility spikes.",
  },
  "60": {
    momentum:  0.25,
    trend:     0.20,
    earnings:  0.25,
    valuation: 0.14,
    quality:   0.11,
    sentiment: 0.05,
    volatilityPenaltyMultiplier: 0.22,
    label: "60d: Earnings & momentum",
    targetDescription: "Medium-term (3-month) relative return. Balanced mix of earnings direction, momentum, and nascent valuation. Moderate risk penalties.",
  },
  "120": {
    momentum:  0.15,
    trend:     0.14,
    earnings:  0.24,
    valuation: 0.22,
    quality:   0.20,
    sentiment: 0.05,
    volatilityPenaltyMultiplier: 0.14,
    label: "120d: Quality & valuation",
    targetDescription: "Intermediate (6-month) relative return. Earnings persistence, business quality, and valuation increasingly predictive. Lower sensitivity to short-term noise.",
  },
  "250": {
    momentum:  0.08,
    trend:     0.10,
    earnings:  0.22,
    valuation: 0.30,
    quality:   0.25,
    sentiment: 0.05,
    volatilityPenaltyMultiplier: 0.08,
    label: "250d: Quality & valuation (1yr)",
    targetDescription: "Long-term (12-month) relative return. Valuation and quality dominate; earnings durability is key; short-term noise is largely irrelevant.",
  },
};

// ─── Core fields for coverage score (Fix #11A) ────────────────────────────────
// These 8 fields are the minimum expected for a well-scored stock.
// A missing field is a real gap, not a neutral value.
// ETFs/funds naturally have fewer → their coverage is computed separately.
const CORE_FIELDS: Array<keyof RawStockData> = [
  "price",
  "ret20d",
  "ret60d",
  "sma50",
  "sma200",
  "pe",
  "roe",
  "grossMargin",
];

// Supplementary fields — present in well-covered stocks, absent in ETFs/thin data
const SUPPLEMENTARY_FIELDS: Array<keyof RawStockData> = [
  "operatingMargin",
  "freeCashFlow",
  "revenueGrowthYoy",
  "analystBuy",
  "priceTarget",
];

/**
 * Compute data coverage score (0-100).
 *
 * For non-fund instruments: checks CORE_FIELDS (weight 2×) and
 * SUPPLEMENTARY_FIELDS (weight 1×). Suspicious / obviously invalid values
 * count as missing (penalty, not neutral).
 *
 * For fund instruments: only price + momentum fields matter — fundamental
 * fields are intentionally absent and must NOT penalise the fund.
 */
export function computeDataCoverage(
  data: RawStockData,
  isFund: boolean
): { coveragePct: number; coverageTier: CoverageTier } {
  if (isFund) {
    // For funds: check price + 3 momentum indicators only
    const fundFields: Array<keyof RawStockData> = ["price", "ret20d", "ret60d", "sma50"];
    const present = fundFields.filter((f) => {
      const v = (data as any)[f];
      return v !== null && v !== undefined && v !== 0;
    }).length;
    const pct = Math.round((present / fundFields.length) * 100);
    return {
      coveragePct: pct,
      coverageTier: pct >= 75 ? "high" : pct >= 50 ? "medium" : "low",
    };
  }

  let score = 0;
  let maxScore = 0;

  // Core fields — weight 2 each
  for (const field of CORE_FIELDS) {
    maxScore += 2;
    const v = (data as any)[field];
    if (v === null || v === undefined) continue;
    // Suspicious value check: impossibly negative prices, zero-price, etc.
    if (field === "price" && (v <= 0 || v > 1_000_000)) continue; // invalid price
    if (field === "pe" && (v < -500 || v > 2000)) continue;       // invalid P/E
    if (field === "roe" && Math.abs(v) > 500) continue;            // invalid ROE
    if (field === "grossMargin" && (v < -200 || v > 100)) continue; // invalid margin
    score += 2;
  }

  // Supplementary fields — weight 1 each
  for (const field of SUPPLEMENTARY_FIELDS) {
    maxScore += 1;
    const v = (data as any)[field];
    if (v !== null && v !== undefined) score += 1;
  }

  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const tier: CoverageTier =
    pct >= 75 ? "high" :
    pct >= 50 ? "medium" : "low";

  return { coveragePct: pct, coverageTier: tier };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (v: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, v));

function scoreReturn(ret: number | undefined | null, good: number, bad: number): number | null {
  if (ret === undefined || ret === null) return null;
  if (good > bad) {
    return clamp(50 + ((ret - (good + bad) / 2) / (good - bad)) * 50);
  } else {
    return clamp(50 - ((ret - (good + bad) / 2) / (bad - good)) * 50);
  }
}

// ─── Factor Scorers ───────────────────────────────────────────────────────────

function scoreMomentum(data: RawStockData): number | null {
  const inputs = [
    data.ret20d  != null ? scoreReturn(data.ret20d,  8,  -8)  : null,
    data.ret60d  != null ? scoreReturn(data.ret60d,  15, -15) : null,
    data.ret120d != null ? scoreReturn(data.ret120d, 20, -20) : null,
  ].filter((v): v is number => v !== null);
  if (inputs.length === 0) return null;
  const weights = [0.20, 0.40, 0.40].slice(3 - inputs.length);
  const sumW = weights.reduce((a, b) => a + b, 0);
  let score = clamp(inputs.reduce((acc, v, i) => acc + v * weights[i], 0) / sumW);
  // 52-week high proximity: within 5% of high = mild momentum boost (+4 pts)
  if (data.high52w && data.price && data.high52w > 0) {
    const pctFromHigh = ((data.high52w - data.price) / data.high52w) * 100;
    if (pctFromHigh <= 5)  score = clamp(score + 4);
  }
  return score;
}

function scoreTrend(data: RawStockData): number | null {
  if (!data.price) return null;
  const scores: number[] = [];
  if (data.sma20)  scores.push(data.price > data.sma20  ? 70 : 30);
  if (data.sma50)  scores.push(data.price > data.sma50  ? 70 : 30);
  if (data.sma200) scores.push(data.price > data.sma200 ? 75 : 25);
  if (data.sma50 && data.sma200)
    scores.push(data.sma50 > data.sma200 ? 70 : 30);
  if (data.rsi14) {
    scores.push(data.rsi14 < 30 ? 80 : data.rsi14 > 75 ? 28 : data.rsi14 > 60 ? 55 : 60);
  }
  if (data.macd != null && data.macdSignal != null)
    scores.push(data.macd > data.macdSignal ? 68 : 32);
  if (scores.length === 0) return null;
  return clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function scoreEarnings(data: RawStockData): number | null {
  const inputs: number[] = [];
  if (data.epsGrowthYoy     != null) inputs.push(scoreReturn(data.epsGrowthYoy,     15, -5) ?? 50);
  if (data.revenueGrowthYoy != null) inputs.push(scoreReturn(data.revenueGrowthYoy, 10, -3) ?? 50);
  if (data.analystBuy != null && data.analystHold != null && data.analystSell != null) {
    const total = data.analystBuy + data.analystHold + data.analystSell;
    if (total > 0) inputs.push(clamp((data.analystBuy / total) * 100));
  }
  if (data.priceTarget && data.price) {
    const upside = ((data.priceTarget - data.price) / data.price) * 100;
    inputs.push(scoreReturn(upside, 15, -5) ?? 50);
  }
  if (inputs.length === 0) return null;
  return clamp(inputs.reduce((a, b) => a + b, 0) / inputs.length);
}

function scoreValuation(data: RawStockData): number | null {
  const inputs: number[] = [];
  if (data.pe != null && data.pe > 0 && data.pe < 200)
    inputs.push(clamp(100 - ((data.pe - 5) / 60) * 80));
  if (data.pb != null && data.pb > 0 && data.pb < 30)
    inputs.push(clamp(100 - ((data.pb - 0.5) / 10) * 80));
  if (data.evEbitda != null && data.evEbitda > 0 && data.evEbitda < 80)
    inputs.push(clamp(100 - ((data.evEbitda - 4) / 30) * 80));
  if (data.high52w && data.low52w && data.price) {
    const range = data.high52w - data.low52w;
    if (range > 0) {
      const pos = (data.price - data.low52w) / range;
      inputs.push(clamp((1 - pos) * 60 + 20));
    }
  }
  if (inputs.length === 0) return null;
  return clamp(inputs.reduce((a, b) => a + b, 0) / inputs.length);
}

function scoreQuality(data: RawStockData): number | null {
  const inputs: number[] = [];
  if (data.grossMargin     != null) inputs.push(scoreReturn(data.grossMargin,     40, 5)  ?? 50);
  if (data.operatingMargin != null) inputs.push(scoreReturn(data.operatingMargin, 15, -5) ?? 50);
  if (data.roe             != null) inputs.push(scoreReturn(data.roe,             15, -5) ?? 50);
  if (data.debtEquity      != null) inputs.push(clamp(100 - (data.debtEquity / 3) * 60));
  if (data.freeCashFlow    != null) inputs.push(data.freeCashFlow > 0 ? 70 : 30);
  if (inputs.length === 0) return null;
  return clamp(inputs.reduce((a, b) => a + b, 0) / inputs.length);
}

function scoreSentiment(data: RawStockData): number | null {
  const inputs: number[] = [];
  if (data.sentimentScore != null) inputs.push(clamp(data.sentimentScore * 100));
  if (data.newsCount24h   != null) inputs.push(data.newsCount24h > 0 ? 55 : 50);
  if (data.volume && data.avgVolume20d && data.avgVolume20d > 0) {
    const ratio = data.volume / data.avgVolume20d;
    inputs.push(ratio > 1.5 ? 58 : ratio < 0.5 ? 45 : 52);
  }
  // Insider open-market buy within 14 days: strong positive signal (+12 pts boost)
  if (data.recentInsiderBuy) inputs.push(80);
  if (inputs.length === 0) return null;
  return clamp(inputs.reduce((a, b) => a + b, 0) / inputs.length);
}

function scoreVolatilityPenalty(data: RawStockData): number | null {
  if (!data.atr14 || !data.price) return null;
  const atrPct = (data.atr14 / data.price) * 100;
  return clamp((atrPct / 5) * 100);
}

// ─── Horizon Score ────────────────────────────────────────────────────────────

function computeHorizonScore(
  factors: FactorBreakdown,
  horizonKey: string
): { score: number; weightsUsed: number; factorsUsed: number } {
  const w = HORIZON_WEIGHTS[horizonKey] ?? HORIZON_WEIGHTS["60"];
  const factorMap: Record<string, number | null> = {
    momentum:  factors.momentum,
    trend:     factors.trend,
    earnings:  factors.earnings,
    valuation: factors.valuation,
    quality:   factors.quality,
    sentiment: factors.sentiment,
  };
  const weightMap: Record<string, number> = {
    momentum:  w.momentum,
    trend:     w.trend,
    earnings:  w.earnings,
    valuation: w.valuation,
    quality:   w.quality,
    sentiment: w.sentiment,
  };

  let weightedSum = 0, weightUsed = 0, factorsUsed = 0;
  for (const [key, weight] of Object.entries(weightMap)) {
    const v = factorMap[key];
    if (v !== null && v !== undefined) {
      weightedSum += v * weight;
      weightUsed  += weight;
      factorsUsed++;
    }
  }

  let score = weightUsed > 0 ? clamp(weightedSum / weightUsed) : 50;

  // Apply volatility penalty, scaled by horizon multiplier
  if (factors.volatilityPenalty != null && factors.volatilityPenalty > 50) {
    score = clamp(score - (factors.volatilityPenalty - 50) * w.volatilityPenaltyMultiplier);
  }

  return { score, weightsUsed: weightUsed, factorsUsed };
}

// ─── Risk Flags ───────────────────────────────────────────────────────────────

function buildRiskFlags(data: RawStockData, factors: FactorBreakdown): string[] {
  const flags: string[] = [];
  if (data.pe && data.pe > 50)   flags.push("High P/E ratio (>50)");
  if (data.pe && data.pe < 0)    flags.push("Negative earnings");
  if (data.debtEquity && data.debtEquity > 2) flags.push("High debt/equity (>2)");
  if (data.rsi14 && data.rsi14 > 75) flags.push("Overbought (RSI > 75)");
  if (data.rsi14 && data.rsi14 < 25) flags.push("Oversold (RSI < 25)");
  if (data.ret250d && data.ret250d < -30) flags.push("Down >30% over 1 year");
  if (data.high52w && data.price && data.high52w > 0) {
    const pctFromHigh = ((data.high52w - data.price) / data.high52w) * 100;
    if (pctFromHigh > 30) flags.push(`${pctFromHigh.toFixed(0)}% below 52-week high`);
  }
  if (data.changePct && Math.abs(data.changePct) > 8) flags.push("Large intraday move (>8%)");
  if (factors.volatilityPenalty && factors.volatilityPenalty > 70) flags.push("Elevated volatility (ATR)");
  if (!data.price && data.error) flags.push(`Data unavailable: ${data.error}`);
  if (data.earningsDate) {
    const diff = (new Date(data.earningsDate).getTime() - Date.now()) / 86_400_000;
    if (diff >= 0 && diff <= 14) flags.push(`Earnings in ${Math.round(diff)} days`);
  }
  return flags;
}

// ─── Horizon-Specific Explanation ────────────────────────────────────────────

function buildHorizonExplanation(
  factors: FactorBreakdown,
  horizonScore: number,
  horizonKey: string,
  signal: string,
  rank?: number,
  percentile?: number
): string {
  const w = HORIZON_WEIGHTS[horizonKey] ?? HORIZON_WEIGHTS["60"];
  const parts: string[] = [];

  const headlines: Record<string, Record<string, string>> = {
    "20": {
      buy:   "Short-term momentum and catalysts appear favorable.",
      watch: "Short-term signals are mixed; no strong momentum edge.",
      avoid: "Short-term momentum and trend signals are weak or deteriorating.",
    },
    "60": {
      buy:   "Medium-term earnings direction and momentum suggest outperformance potential.",
      watch: "Medium-term signals are mixed; balanced risk/reward.",
      avoid: "Medium-term signals indicate elevated underperformance risk.",
    },
    "120": {
      buy:   "Business quality, earnings persistence, and valuation support a constructive 6-month view.",
      watch: "Quality and valuation mixed; intermediate-term outlook neutral.",
      avoid: "Weak quality, stretched valuation, or deteriorating earnings create 6-month headwinds.",
    },
    "250": {
      buy:   "Strong quality and attractive valuation support a favorable 12-month thesis.",
      watch: "Long-term quality and valuation are neutral; no clear 12-month thesis.",
      avoid: "Weak fundamentals or stretched valuation create 12-month headwinds.",
    },
  };

  parts.push(headlines[horizonKey]?.[signal] ?? "Signals are mixed.");

  if (rank !== undefined && percentile !== undefined) {
    parts.push(
      `[${w.label}] Rank #${rank} (top ${Math.round(100 - percentile)}%, score ${horizonScore.toFixed(1)}/100).`
    );
  } else {
    parts.push(`[${w.label}] Score: ${horizonScore.toFixed(1)}/100.`);
  }

  const positives: string[] = [];
  const concerns: string[] = [];

  const checks: Array<[number | null, number, string, string]> = [
    [factors.momentum,  w.momentum,  "strong momentum",            "weak/negative momentum"],
    [factors.trend,     w.trend,     "confirmed uptrend",          "below key moving averages"],
    [factors.earnings,  w.earnings,  "favorable earnings",         "deteriorating earnings"],
    [factors.valuation, w.valuation, "attractive valuation",       "stretched valuation"],
    [factors.quality,   w.quality,   "high-quality fundamentals",  "weak fundamentals"],
  ];

  for (const [val, weight, posLabel, negLabel] of checks) {
    if (val === null) continue;
    const threshold = weight >= 0.15 ? { pos: 65, neg: 38 } : { pos: 70, neg: 32 };
    if (val >= threshold.pos) positives.push(posLabel);
    else if (val <= threshold.neg) concerns.push(negLabel);
  }

  if (positives.length > 0) parts.push(`Positives: ${positives.join(", ")}.`);
  if (concerns.length > 0)  parts.push(`Concerns: ${concerns.join(", ")}.`);

  const factorsAvail = [factors.momentum, factors.trend, factors.earnings,
    factors.valuation, factors.quality, factors.sentiment].filter(v => v !== null).length;
  if (factorsAvail < 4) parts.push(`Note: only ${factorsAvail}/6 factors available — confidence reduced.`);

  parts.push("⚠ Probabilistic model output. Not financial advice.");
  return parts.join(" ");
}

// ─── Confidence ───────────────────────────────────────────────────────────────

function computeConfidence(
  factors: FactorBreakdown,
  horizonScore: number,
  horizonKey: string,
  weightsUsed: number,
  factorsUsed: number
): number {
  const dataAvailability = factorsUsed / 6;
  const signalStrength   = Math.abs(horizonScore - 50) / 50;
  let confidence = dataAvailability * 65 + signalStrength * 35;

  // Longer horizons = intrinsically harder to call
  const horizonDiscount: Record<string, number> = { "20": 0, "60": 4, "120": 9, "250": 15 };
  confidence -= (horizonDiscount[horizonKey] ?? 0);

  // Volatility reduces confidence, more so for shorter horizons
  if (factors.volatilityPenalty != null && factors.volatilityPenalty > 50) {
    const w = HORIZON_WEIGHTS[horizonKey] ?? HORIZON_WEIGHTS["60"];
    confidence -= (factors.volatilityPenalty - 50) * w.volatilityPenaltyMultiplier * 0.5;
  }

  if (weightsUsed < 0.8) confidence *= weightsUsed;

  return clamp(confidence);
}

// ─── rankStock ────────────────────────────────────────────────────────────────
// Accepts optional sector override (sector string + assetType) to enable
// sector-aware field exclusions. These are passed in by rankMultiple() which
// has universe metadata; single-ticker refresh passes them via routes.ts.
export function rankStock(
  data: RawStockData,
  sector?: string | null,
  assetType?: string | null,
): RankingResult {
  const now = new Date().toISOString();

  // ── Fix #12: apply sector exclusions before scoring ────────────────────────
  const sectorGroup: SectorGroup = resolveSectorGroup(sector, assetType);
  const rules = SECTOR_RULES[sectorGroup];
  const scoringData = applyExclusions(data, rules);

  // ── Fix #11A: compute coverage BEFORE exclusions (on raw data) ──────────────
  const { coveragePct, coverageTier } = computeDataCoverage(data, rules.isFund);

  const factors: FactorBreakdown = {
    momentum:          scoreMomentum(scoringData),
    trend:             scoreTrend(scoringData),
    earnings:          scoreEarnings(scoringData),
    valuation:         scoreValuation(scoringData),
    quality:           scoreQuality(scoringData),
    sentiment:         scoreSentiment(scoringData),
    volatilityPenalty: scoreVolatilityPenalty(scoringData),
  };

  const { score: baseScore, factorsUsed } = computeHorizonScore(factors, "60");
  const compositeScore = Math.round(baseScore * 10) / 10;

  const horizons = ["20", "60", "120", "250"] as const;
  const signals: RankingResult["signals"] = {} as any;

  for (const h of horizons) {
    const { score, weightsUsed, factorsUsed: fu } = computeHorizonScore(factors, h);
    const confidence = computeConfidence(factors, score, h, weightsUsed, fu);
    signals[`d${h}` as keyof typeof signals] = {
      signal:        "watch" as const,
      confidence:    Math.round(confidence * 10) / 10,
      compositeScore: Math.round(score * 10) / 10,
      explanation:   buildHorizonExplanation(factors, score, h, "watch"),
      factorWeights: HORIZON_WEIGHTS[h],
    };
  }

  const riskFlags = buildRiskFlags(data, factors);

  return {
    ticker: data.ticker,
    generatedAt: now,
    factors,
    compositeScore,
    signals,
    riskFlags,
    explanation: signals.d60.explanation ?? "",
    dataAvailability: factorsUsed / 6,
    dataCoverage: coveragePct,
    coverageTier,
    sectorGroup,
    sectorNote: getSectorNote(sectorGroup),
  };
}

// ─── rankMultiple ─────────────────────────────────────────────────────────────

export function rankMultiple(
  dataList: RawStockData[],
  strictness = "balanced",
  // Optional: parallel array of { sector, assetType } matching dataList order.
  // When provided (e.g. from routes.ts which has universe metadata), sector
  // rules are applied. When absent, falls back to generic.
  universeMetadata?: Array<{ sector?: string | null; assetType?: string | null }>
): RankingResult[] {
  const config = STRICTNESS_PRESETS[strictness] ?? STRICTNESS_PRESETS.balanced;
  const results = dataList.map((d, i) => {
    const meta = universeMetadata?.[i];
    return rankStock(d, meta?.sector, meta?.assetType);
  });
  const n = results.length;
  if (n === 0) return [];

  for (const h of ["20", "60", "120", "250"] as const) {
    const key = `d${h}` as keyof RankingResult["signals"];
    const sorted = [...results]
      .map((r, i) => ({ i, score: r.signals[key].compositeScore }))
      .sort((a, b) => b.score - a.score);

    const buyCount   = Math.max(1, Math.ceil((config.buyTopPct / 100) * n));
    const watchCount = Math.max(1, Math.ceil((config.watchPct / 100) * n));

    sorted.forEach(({ i }, rank0) => {
      const rank1      = rank0 + 1;
      const percentile = ((n - rank0) / n) * 100;
      const r = results[i];

      // ── Fix #11A + #12: post-ranking label cap ─────────────────────────────
      // Base signal from percentile bucket
      let signal: "buy" | "watch" | "avoid" =
        rank1 <= buyCount ? "buy" : rank1 <= buyCount + watchCount ? "watch" : "avoid";

      // Rule 1: ETF/fund instruments → always Watch (never Buy)
      const sectorGroup = r.sectorGroup as SectorGroup;
      const sectorRules = SECTOR_RULES[sectorGroup];
      if (sectorRules.isFund) {
        signal = "watch";
      }

      // Rule 2: Low coverage → cap at Watch
      if (r.coverageTier === "low" && signal === "buy") {
        signal = "watch";
      }

      // Rule 3: Medium coverage → Buy allowed only if sector buy-gate passes
      if (r.coverageTier === "medium" && signal === "buy") {
        // Need at least one required field present for this sector
        // (passesBuyGate checks requiredForBuy array against original data)
        // We stored sectorGroup on the result; re-check via rules object
        const buyGatePassed = passesBuyGate(
          // scoringData was patched — use original signals/factors as proxy:
          // We check required fields directly on dataList[i] (original raw)
          dataList[i],
          sectorRules
        );
        if (!buyGatePassed) signal = "watch";
      }

      const prev = r.signals[key];
      results[i].signals[key] = {
        ...prev,
        signal,
        rank: rank1,
        percentile: Math.round(percentile * 10) / 10,
        explanation: buildHorizonExplanation(
          r.factors, prev.compositeScore, h, signal, rank1, percentile
        ),
      };
    });
  }

  // Store 60d explanation as primary
  for (const r of results) r.explanation = r.signals.d60.explanation ?? r.explanation;

  return results.sort((a, b) => b.signals.d60.compositeScore - a.signals.d60.compositeScore);
}
