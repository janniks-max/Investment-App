/**
 * Sector Rules Layer — wraps the base ranking engine with sector-aware logic.
 *
 * Design principles:
 *  - ONE compact config object per sector group (SECTOR_RULES).
 *  - Base engine is NEVER rewritten — we only adjust which inputs are passed in
 *    and apply post-score overrides before labels are assigned.
 *  - If a metric is not meaningful for a sector, it is excluded (set to null)
 *    so the base engine treats it as missing rather than penalising the stock.
 *  - ETF/fund instruments receive a special "fund" treatment — no company-style
 *    Strong Buy; recommendation is capped at "watch" regardless of rank.
 *  - "Strong Buy" (top percentile buy) is blocked unless coverage is also high.
 *
 * To add a new sector: add one entry to SECTOR_RULES and optionally extend
 * SECTOR_GROUP_MAP with the new sector string(s).
 */

import type { RawStockData } from "./dataFetcher";

// ─── Sector group identifiers ────────────────────────────────────────────────
// These are the canonical groups referenced throughout this file.
export type SectorGroup =
  | "financials"
  | "technology"
  | "industrials"
  | "healthcare"
  | "consumer"
  | "energy_materials"
  | "fund"      // ETFs, funds, trust-like instruments
  | "generic";  // fallback for unknown sectors

// ─── Per-sector rules definition ─────────────────────────────────────────────
export interface SectorRules {
  /**
   * Fields to null-out before scoring (not meaningful for this sector).
   * Excluded fields are treated as "missing" by the engine, not penalties.
   */
  excludeFields: Array<keyof RawStockData>;

  /**
   * Fields that are REQUIRED for a stock in this sector to reach "buy".
   * If any required field is null, the label is capped at "watch".
   * (Applied as a post-scoring override — does not change factor weights.)
   */
  requiredForBuy: Array<keyof RawStockData>;

  /**
   * If true, this instrument should never receive a company-style recommendation.
   * The label is always forced to "watch" regardless of rank and score.
   */
  isFund: boolean;

  /**
   * Human-readable note shown in UI / explanation text.
   * Keep short — one sentence describing the sector adjustment applied.
   */
  note: string;
}

// ─── Sector rules config ──────────────────────────────────────────────────────
// One entry per sector group. Extend here — nowhere else.
export const SECTOR_RULES: Record<SectorGroup, SectorRules> = {

  // ── Financials / Banks / Insurance ─────────────────────────────────────────
  // grossMargin is meaningless for banks (no COGS model); EV/EBITDA also not
  // applicable. ROE and P/B are the primary value anchors instead.
  financials: {
    excludeFields: ["grossMargin", "evEbitda"],
    requiredForBuy: ["pe", "roe"],
    isFund: false,
    note: "Financials: gross margin and EV/EBITDA excluded (not applicable); ROE and P/E required for Buy.",
  },

  // ── Technology / Software / Semiconductors ─────────────────────────────────
  // FCF yield and revenue growth are the most meaningful metrics; P/E can be
  // high by design for growth names so we don't over-penalise via valuation.
  // debtEquity can be distorted by buyback leverage — still informative but
  // not a blocker on its own.
  technology: {
    excludeFields: [],
    requiredForBuy: ["revenueGrowthYoy", "grossMargin"],
    isFund: false,
    note: "Technology: revenue growth and gross margin required for Buy.",
  },

  // ── Industrials / Manufacturing / Aerospace / Defense ──────────────────────
  // Cyclical sector — operating margin and FCF are the most reliable signals.
  // grossMargin is informative but lower thresholds are normal.
  industrials: {
    excludeFields: [],
    requiredForBuy: ["operatingMargin", "pe"],
    isFund: false,
    note: "Industrials: operating margin and P/E required for Buy.",
  },

  // ── Healthcare / Pharma / Biotech ───────────────────────────────────────────
  // R&D-heavy; negative earnings common in early-stage biotech. FCF and
  // revenueGrowth are the anchors; grossMargin is relevant for pharma but
  // not for pure biotech — we include it as informative, not required.
  healthcare: {
    excludeFields: ["debtEquity"], // leverage norms differ widely; exclude as penalty
    requiredForBuy: ["revenueGrowthYoy"],
    isFund: false,
    note: "Healthcare: debt/equity excluded (norms vary); revenue growth required for Buy.",
  },

  // ── Consumer (Staples + Discretionary) ─────────────────────────────────────
  // Dividend yield and brand value matter; gross margin is a key differentiator.
  consumer: {
    excludeFields: [],
    requiredForBuy: ["grossMargin", "pe"],
    isFund: false,
    note: "Consumer: gross margin and P/E required for Buy.",
  },

  // ── Energy / Utilities / Materials ─────────────────────────────────────────
  // Commodity-driven; FCF and dividend yield are primary. grossMargin varies
  // hugely by sub-sector (refining vs. upstream). evEbitda is standard here.
  energy_materials: {
    excludeFields: [],
    requiredForBuy: ["freeCashFlow", "pe"],
    isFund: false,
    note: "Energy/Materials: FCF and P/E required for Buy.",
  },

  // ── ETFs / Funds / Trust-like instruments ───────────────────────────────────
  // ETFs and funds have no company fundamentals. Earnings, quality, and
  // valuation factors based on company financials are meaningless.
  // These instruments are capped at "watch" — never receive a Buy label.
  fund: {
    excludeFields: [
      "pe", "pb", "eps", "epsGrowthYoy", "revenueGrowthYoy",
      "grossMargin", "operatingMargin", "roe", "debtEquity", "freeCashFlow",
      "evEbitda", "analystBuy", "analystHold", "analystSell", "priceTarget",
    ],
    requiredForBuy: [], // irrelevant — isFund=true caps label regardless
    isFund: true,
    note: "ETF/Fund: company-style financials excluded; capped at Watch (not Buy).",
  },

  // ── Generic fallback ────────────────────────────────────────────────────────
  // No exclusions, no special requirements — base engine runs as-is.
  generic: {
    excludeFields: [],
    requiredForBuy: [],
    isFund: false,
    note: "",
  },
};

// ─── Sector → group mapping ───────────────────────────────────────────────────
// Maps the `sector` strings stored in the universe table to a SectorGroup.
// Case-insensitive prefix/substring matching is applied in resolveSectorGroup().
// To add a new sector string: add it to the array for the relevant group.
const SECTOR_GROUP_MAP: Record<SectorGroup, string[]> = {
  financials: [
    "financials", "banks", "banking", "insurance", "financial services",
    "diversified financials", "capital markets", "real estate",
  ],
  technology: [
    "technology", "software", "semiconductors", "it services",
    "information technology", "tech", "hardware", "electronic",
  ],
  industrials: [
    "industrials", "manufacturing", "aerospace", "defense", "machinery",
    "transportation", "construction", "engineering",
  ],
  healthcare: [
    "healthcare", "pharma", "biotech", "medical", "health care",
    "life sciences", "biotechnology", "pharmaceutical",
  ],
  consumer: [
    "consumer", "retail", "discretionary", "staples", "food", "beverage",
    "household", "personal products", "apparel",
  ],
  energy_materials: [
    "energy", "oil", "gas", "utilities", "materials", "chemicals",
    "mining", "metals", "commodities",
  ],
  fund: [
    "etf", "fund", "index fund", "broad market", "trust", "reit",
    "exchange-traded", "fixed income", "bond",
  ],
  generic: [],
};

/**
 * Resolve a sector string (from universe table) to a SectorGroup.
 * Falls back to "generic" if no match is found.
 */
export function resolveSectorGroup(
  sector: string | null | undefined,
  assetType: string | null | undefined
): SectorGroup {
  // ETF/fund by asset_type always → fund group
  if (assetType === "etf" || assetType === "fund") return "fund";

  if (!sector) return "generic";
  const lower = sector.toLowerCase();

  for (const [group, keywords] of Object.entries(SECTOR_GROUP_MAP) as [SectorGroup, string[]][]) {
    if (keywords.some((kw) => lower.includes(kw))) return group;
  }
  return "generic";
}

/**
 * Apply sector rules to a RawStockData object before it is passed to rankStock().
 *
 * Excluded fields are zeroed out (set to undefined) so the base engine treats
 * them as genuinely missing — not as 0-values that would be scored.
 *
 * Returns a shallow copy of the data with excluded fields set to undefined.
 * The original object is not mutated.
 */
export function applyExclusions(
  data: RawStockData,
  rules: SectorRules
): RawStockData {
  if (rules.excludeFields.length === 0) return data;
  const patched = { ...data };
  for (const field of rules.excludeFields) {
    (patched as any)[field] = undefined;
  }
  return patched;
}

/**
 * Check whether a stock passes the sector-specific "required for Buy" gate.
 *
 * Returns true if all required fields are present (non-null).
 * If any required field is missing, returns false — the label should be
 * capped at "watch" regardless of rank percentile.
 */
export function passesBuyGate(
  data: RawStockData,
  rules: SectorRules
): boolean {
  if (rules.isFund) return false; // funds never pass
  return rules.requiredForBuy.every((field) => {
    const v = (data as any)[field];
    return v !== null && v !== undefined;
  });
}

/**
 * Return the sector note string for a given sector group (for UI/explanation).
 */
export function getSectorNote(group: SectorGroup): string {
  return SECTOR_RULES[group].note;
}
