/**
 * Opportunity Engine — v2
 * 100% INDEPENDENT of Buy/Watch/Avoid scoring system.
 * DOES NOT touch: signal labels, factor weights, horizon profiles, ranking engine.
 *
 * Scoring philosophy: ABSOLUTE, self-referential metrics.
 * Each stock is scored against its own fundamentals — NOT ranked against peers.
 * Two stocks can both score 60 if they both have ~60% analyst upside.
 *
 * Upside components (actual % values, not percentiles):
 *   - Analyst upside %: (targetMeanPrice - price) / price × 100
 *   - 52w-high upside %: (52w high - price) / price × 100
 *   - Revenue growth CAGR %
 *   - EPS growth CAGR %
 *   - Thematic multiplier: 1.0x–1.5x (amplifies pure-play structural names)
 *
 * Risk components (absolute self-referential):
 *   - Drawdown risk %: (price - 52w low) / price × 100 (how far it could fall)
 *   - ATR % of price: daily volatility in real terms
 *   - Beta: raw value
 *   - Debt/Equity: raw value
 *
 * Horizon weights shift between analyst/52w (short-term) ↔ growth/thematic (long-term).
 */

import type { RawStockData } from "./dataFetcher";

// ─── Theme definitions ────────────────────────────────────────────────────────
// 11 themes: original 8 + Longevity, Water/Food Security, Urbanization/Smart Cities
export const THEMES = {
  "🤖 AI/ML": {
    keywords: ["artificial intelligence","machine learning","deep learning","neural","nlp","language model","ai platform","generative","llm","data center","gpu","semiconductor ai","automation","robotics","computer vision","autonomous"],
    sectors: ["Technology","Communication Services"],
    tickers: ["NVDA","AMD","GOOGL","GOOG","META","MSFT","AMZN","PLTR","AI","BBAI","SOUN","CEVA","PATH","FARO","VRNS","DDOG","SNOW","CFLT","TSM","ASML","ARM","SMCI"],
  },
  "⚛️ Quantum Computing": {
    keywords: ["quantum","qubit","quantum computing","quantum hardware","quantum software","ion trap","superconducting qubit","quantum cryptography","quantum network"],
    sectors: ["Technology"],
    tickers: ["IONQ","RGTI","QUBT","IBM","GOOGL","MSFT","HON","AMAT","QMCO","ARQQ"],
  },
  "🛡️ Defense & Cybersecurity": {
    keywords: ["defense","defence","cybersecurity","cyber security","military","aerospace defense","weapon","surveillance","intelligence","dod","pentagon","nato","endpoint security","zero trust","siem","firewall","threat detection","signals intelligence"],
    sectors: ["Industrials","Information Technology"],
    tickers: ["LMT","RTX","NOC","GD","HII","LHX","HWM","AXON","CRWD","PANW","FTNT","CYBR","ZS","OKTA","S","NET","SAIC","LDOS","BAH","CACI","AIR.PA","RHM.DE","BA.L","SAAB.ST"],
  },
  "☢️ Nuclear/Clean Energy": {
    keywords: ["nuclear","uranium","fusion","fission","reactor","small modular reactor","smr","clean energy","renewable","wind","solar","hydropower","geothermal","grid","utility","power generation"],
    sectors: ["Utilities","Energy"],
    tickers: ["CCJ","NXE","DNN","UEC","LTBR","BWXT","CEG","VST","NRG","EXC","ETR","D","NEE","AES","BE","PLUG","FCEL","RWE.DE","EDF.PA","EDP.LS","ENEL.MI"],
  },
  "🧬 Biotech/Genomics": {
    keywords: ["biotech","genomics","gene editing","crispr","mrna","immunotherapy","oncology","biopharmaceutical","clinical trial","drug discovery","antibody","gene therapy","cell therapy","precision medicine","proteomics","diagnostics"],
    sectors: ["Health Care","Biotechnology","Pharmaceuticals"],
    tickers: ["MRNA","BNTX","CRSP","NTLA","BEAM","EDIT","PACB","NVAX","VRTX","REGN","BIIB","ALNY","GILD","ABBV","BMY","AMGN","ILMN","NVCR","EXAS","NVO","AZN","ROCHE.SW"],
  },
  "🏗️ Infrastructure & Industrials": {
    keywords: ["infrastructure","construction","engineering","industrial","manufacturing","logistics","transportation","supply chain","railway","highway","bridge","utility infrastructure","electrical grid","ports","water treatment"],
    sectors: ["Industrials","Materials","Utilities"],
    tickers: ["CAT","DE","EMR","HON","GE","MMM","ITW","ETN","PH","ROK","DOV","IR","XYL","CARR","OTIS","WM","RSG","FAST","GWW","MSC","SIE.DE","ABB","CNQ"],
  },
  "🔋 Energy Transition/Batteries": {
    keywords: ["battery","ev","electric vehicle","energy storage","lithium","cobalt","nickel","charging","fuel cell","hydrogen","clean transportation","electrification","solar panel","wind turbine","grid storage"],
    sectors: ["Energy","Industrials","Consumer Discretionary","Materials"],
    tickers: ["TSLA","RIVN","LCID","NIO","XPEV","LI","CHPT","EVGO","BLNK","PLUG","BE","ENPH","SEDG","FSLR","RUN","ARRY","ALB","SQM","MP","LTHM","PTRA","BYD"],
  },
  "🚀 Space & Satellite": {
    keywords: ["space","satellite","launch","rocket","orbit","aerospace","spacecraft","constellation","remote sensing","gps","communications satellite","starlink","leo","geo","cubesat","hypersonic"],
    sectors: ["Industrials","Communication Services","Technology"],
    tickers: ["RKLB","ASTS","VSAT","PL","KTOS","BWXT","NOC","LMT","RTX","BA","HII","SPIR","MNTS","ORBK","AIR.PA"],
  },
  "💊 Longevity & Anti-Aging": {
    keywords: ["longevity","anti-aging","aging","lifespan","healthspan","senolytics","telomere","epigenetics","rapamycin","nad+","caloric restriction","alzheimer","parkinson","neurodegeneration","age-related","regenerative medicine","stem cell"],
    sectors: ["Health Care","Biotechnology","Pharmaceuticals"],
    tickers: ["UNITY","LIFE","CALB","SRTX","ALT","INVA","BHVN","SAGE","PRAX","AGIO","RARE","ALNY","IONS","REGN","LLY","NVO","ABBV","BMY"],
  },
  "🌊 Water & Food Security": {
    keywords: ["water","irrigation","desalination","water treatment","water management","food security","agriculture","agri","crop","fertilizer","seed","precision agriculture","aquaculture","food supply","food technology","sustainable farming"],
    sectors: ["Materials","Industrials","Consumer Staples","Utilities"],
    tickers: ["XYL","WTRG","AWK","AWR","SJW","MSEX","POWI","NTR","MOS","CF","ADM","BG","CTVA","FMC","ICL","DE","CNH","AGR","USGR"],
  },
  "🏙️ Urbanization & Smart Cities": {
    keywords: ["smart city","urban","urbanization","iot","internet of things","building automation","smart grid","5g infrastructure","connected infrastructure","traffic management","real estate tech","proptech","building management","smart building","city technology"],
    sectors: ["Technology","Real Estate","Communication Services","Industrials"],
    tickers: ["ENPH","ITRI","TRMB","REXR","AMT","CCI","SBAC","EQIX","PLD","CONE","DLR","UNIT","HUBS","VEEV","DDOG","FSLY","NET","TWLO","DOCN"],
  },
} as const;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

// ─── Theme assignment with strength ──────────────────────────────────────────
export interface ThemeMatch {
  theme: ThemeName;
  strength: "pure" | "direct" | "indirect"; // pure=1.5x, direct=1.3x, indirect=1.1x
}

export function assignThemesWithStrength(
  ticker: string,
  name: string,
  sector: string | null,
  industry: string | null
): ThemeMatch[] {
  const matches: ThemeMatch[] = [];
  const searchText = `${name} ${sector ?? ""} ${industry ?? ""}`.toLowerCase();
  const tickerUpper = ticker.split(".")[0].toUpperCase();

  for (const [theme, config] of Object.entries(THEMES) as [ThemeName, typeof THEMES[ThemeName]][]) {
    const inTickerList = config.tickers.includes(tickerUpper);
    const keywordCount = config.keywords.filter((kw) => searchText.includes(kw)).length;

    if (inTickerList && keywordCount >= 2) {
      matches.push({ theme, strength: "pure" });
    } else if (inTickerList || keywordCount >= 2) {
      matches.push({ theme, strength: "direct" });
    } else if (keywordCount === 1) {
      matches.push({ theme, strength: "indirect" });
    }
  }

  return matches;
}

// Backwards-compat: return just theme names
export function assignThemes(
  ticker: string,
  name: string,
  sector: string | null,
  industry: string | null
): ThemeName[] {
  return assignThemesWithStrength(ticker, name, sector, industry).map((m) => m.theme);
}

// ─── Thematic multiplier ──────────────────────────────────────────────────────
// Returns a multiplier 1.0x–1.5x based on best match strength and theme count
function computeThematicMultiplier(themeMatches: ThemeMatch[]): number {
  if (themeMatches.length === 0) return 1.0;
  const bestStrength = themeMatches.reduce((best, m) => {
    const order = { pure: 3, direct: 2, indirect: 1 };
    return order[m.strength] > order[best] ? m.strength : best;
  }, "indirect" as "pure" | "direct" | "indirect");
  const countBonus = Math.min(0.1, (themeMatches.length - 1) * 0.03);
  const base = bestStrength === "pure" ? 1.5 : bestStrength === "direct" ? 1.3 : 1.1;
  return Math.min(1.5, base + countBonus);
}

// ─── Horizon weight profiles ──────────────────────────────────────────────────
// These are SEPARATE from the Buy/Watch/Avoid horizon weights.
// Weight distribution over upside components per horizon.
export interface HorizonUpsideWeights {
  analystTarget: number;    // % weight for analyst consensus upside
  high52w: number;          // % weight for 52-week high upside
  revenueCAGR: number;      // % weight for revenue growth
  epsCAGR: number;          // % weight for EPS growth
  valuationRerating: number; // % weight for valuation rerating (PEG-based)
  thematic: number;         // % weight for thematic multiplier boost
}

export const OPPORTUNITY_HORIZON_PROFILES: Record<string, {
  upsideWeights: HorizonUpsideWeights;
  riskWeights: { drawdown: number; atrPct: number; beta: number; debtEquity: number };
  label: string;
  description: string;
}> = {
  "1y": {
    //                          analyst  52w    revCAGR  epsCAGR  valRerate  thematic  → sums to 1.0
    upsideWeights: { analystTarget: 0.35, high52w: 0.27, revenueCAGR: 0.13, epsCAGR: 0.10, valuationRerating: 0.10, thematic: 0.05 },
    riskWeights:   { drawdown: 0.30, atrPct: 0.35, beta: 0.25, debtEquity: 0.10 },
    label: "1 Year",
    description: "Short-term: analyst targets, near-term recovery, and valuation re-rating potential dominate. Thematic exposure is a minor bonus.",
  },
  "3y": {
    upsideWeights: { analystTarget: 0.25, high52w: 0.17, revenueCAGR: 0.20, epsCAGR: 0.16, valuationRerating: 0.12, thematic: 0.10 },
    riskWeights:   { drawdown: 0.25, atrPct: 0.30, beta: 0.28, debtEquity: 0.17 },
    label: "3 Years",
    description: "Medium-term: analyst guidance, fundamental growth and valuation re-rating. Thematic exposure starts mattering.",
  },
  "5y": {
    upsideWeights: { analystTarget: 0.15, high52w: 0.10, revenueCAGR: 0.26, epsCAGR: 0.22, valuationRerating: 0.09, thematic: 0.18 },
    riskWeights:   { drawdown: 0.20, atrPct: 0.25, beta: 0.28, debtEquity: 0.27 },
    label: "5 Years",
    description: "Growth horizon: revenue and EPS CAGR drive most of the score. Structural themes matter. Analyst targets are a smaller signal.",
  },
  "10y": {
    upsideWeights: { analystTarget: 0.08, high52w: 0.05, revenueCAGR: 0.28, epsCAGR: 0.25, valuationRerating: 0.07, thematic: 0.27 },
    riskWeights:   { drawdown: 0.15, atrPct: 0.18, beta: 0.27, debtEquity: 0.40 },
    label: "10 Years",
    description: "Long-term: structural mega-trend exposure and compounding growth dominate. Analyst targets are nearly irrelevant.",
  },
  "20y": {
    upsideWeights: { analystTarget: 0.04, high52w: 0.03, revenueCAGR: 0.28, epsCAGR: 0.18, valuationRerating: 0.07, thematic: 0.40 },
    riskWeights:   { drawdown: 0.10, atrPct: 0.12, beta: 0.25, debtEquity: 0.53 },
    label: "20 Years",
    description: "Generational horizon: pure-play exposure to structural mega-trends is paramount. Financial leverage risk dominates the risk side.",
  },
};

// ─── Raw absolute component calculations ─────────────────────────────────────

/** Returns analyst upside as a raw % (e.g. +47.3 means 47.3% upside to target). */
function calcAnalystUpsidePct(price?: number, priceTarget?: number): number | null {
  if (!price || !priceTarget || price <= 0 || priceTarget <= 0) return null;
  return ((priceTarget - price) / price) * 100;
}

/** Returns 52w-high upside as a raw % (e.g. +18.2 means 18.2% to get back to 52w high). */
function calc52wHighUpsidePct(price?: number, high52w?: number): number | null {
  if (!price || !high52w || price <= 0 || high52w <= 0) return null;
  return ((high52w - price) / price) * 100;
}

/** Returns drawdown risk as % (how far price could fall back to 52w low). */
function calcDrawdownRiskPct(price?: number, low52w?: number): number | null {
  if (!price || !low52w || price <= 0 || low52w <= 0) return null;
  return ((price - low52w) / price) * 100;
}

/** Returns ATR as % of price. */
function calcAtrPct(atr14?: number, price?: number): number | null {
  if (!atr14 || !price || price <= 0) return null;
  return (atr14 / price) * 100;
}

// ─── Score normalisation helpers ──────────────────────────────────────────────
// These convert raw absolute % values into a 0–100 contribution scale.
// Key principle: the numbers map real-world % ranges to score ranges — no cross-sectional ranking.

/** Analyst upside %  → 0-100 contribution score.
 *  -50%+ → 0, 0% → 35, +20% → 60, +50% → 80, +100%+ → 100 */
function normAnalystUpside(pct: number | null): number {
  if (pct === null) return 35; // neutral if no target available
  if (pct <= -50) return 0;
  if (pct <= 0)   return 35 * (1 + pct / 50);
  if (pct <= 20)  return 35 + (pct / 20) * 25;
  if (pct <= 50)  return 60 + ((pct - 20) / 30) * 20;
  if (pct <= 100) return 80 + ((pct - 50) / 50) * 15;
  return 95;
}

/** 52w high upside % → 0-100 contribution score.
 *  Already at/above 52w high (≤0%) → 20 (limited near-term recovery), +30% → 65, +60%+ → 95 */
function norm52wUpside(pct: number | null): number {
  if (pct === null) return 30;
  if (pct <= 0)  return 20;  // already at or above 52w high
  if (pct <= 10) return 20 + (pct / 10) * 20;
  if (pct <= 30) return 40 + ((pct - 10) / 20) * 25;
  if (pct <= 60) return 65 + ((pct - 30) / 30) * 25;
  return 90;
}

/** Revenue growth % (YoY CAGR proxy) → 0-100 contribution score.
 *  Negative → 0-30, 0-10% → 30-50, 10-25% → 50-70, 25-50% → 70-88, 50%+ → 88-100 */
function normRevenueGrowth(pct: number | null | undefined): number {
  if (pct == null) return 35; // neutral if unavailable
  if (pct <= -20) return 0;
  if (pct <= 0)   return 30 * (1 + pct / 20);
  if (pct <= 10)  return 30 + (pct / 10) * 20;
  if (pct <= 25)  return 50 + ((pct - 10) / 15) * 20;
  if (pct <= 50)  return 70 + ((pct - 25) / 25) * 18;
  return Math.min(100, 88 + ((pct - 50) / 50) * 12);
}

/** EPS growth % (YoY CAGR proxy) → 0-100 contribution score. */
function normEpsGrowth(pct: number | null | undefined): number {
  if (pct == null) return 35;
  if (pct <= -30) return 0;
  if (pct <= 0)   return 30 * (1 + pct / 30);
  if (pct <= 15)  return 30 + (pct / 15) * 22;
  if (pct <= 30)  return 52 + ((pct - 15) / 15) * 23;
  if (pct <= 60)  return 75 + ((pct - 30) / 30) * 18;
  return Math.min(100, 93 + ((pct - 60) / 40) * 7);
}

/** Drawdown risk % → 0-100 risk contribution.
 *  High drawdown risk (already up >80% from 52w low) = high risk score because more room to fall.
 *  Low drawdown (close to 52w low) = already beaten down, less downside from here.
 *
 *  Wait — actually the metric is (price - 52w low)/price × 100.
 *  If this is 60% it means price is 60% above 52w low → lots of room to fall back → HIGH risk.
 *  If this is 5% it means price is near 52w low → limited downside → LOW risk.
 */
function normDrawdownRisk(pct: number | null): number {
  if (pct === null) return 40;
  // pct = how far price has risen above 52w low as % of current price
  // 0–5%: near 52w low, limited downside → risk score 15
  // 5–20%: moderate → 25-45
  // 20–40%: normal → 45-65
  // 40–60%: elevated → 65-80
  // 60%+: far from 52w low, high potential reversion → 80-95
  if (pct <= 5)  return 15;
  if (pct <= 20) return 15 + ((pct - 5) / 15) * 30;
  if (pct <= 40) return 45 + ((pct - 20) / 20) * 20;
  if (pct <= 60) return 65 + ((pct - 40) / 20) * 15;
  return Math.min(95, 80 + ((pct - 60) / 40) * 15);
}

/** ATR % of price → 0-100 risk contribution.
 *  <1%: very low volatility → 10. 5%+: high → 85 */
function normAtrRisk(pct: number | null): number {
  if (pct === null) return 40;
  if (pct <= 1.0) return 10;
  if (pct <= 2.0) return 10 + ((pct - 1) / 1) * 20;
  if (pct <= 3.5) return 30 + ((pct - 2) / 1.5) * 25;
  if (pct <= 5.0) return 55 + ((pct - 3.5) / 1.5) * 20;
  if (pct <= 8.0) return 75 + ((pct - 5) / 3) * 10;
  return Math.min(100, 85 + (pct - 8) * 2.5);
}

/** Beta → 0-100 risk contribution.
 *  <0.5: very low → 10. 1.0: market → 45. 2.0+: very high → 90 */
function normBetaRisk(beta: number | null | undefined): number {
  if (beta == null) return 40;
  if (beta < 0.3) return 10;
  if (beta < 0.8) return 10 + ((beta - 0.3) / 0.5) * 30;
  if (beta < 1.2) return 40 + ((beta - 0.8) / 0.4) * 20;
  if (beta < 1.6) return 60 + ((beta - 1.2) / 0.4) * 15;
  if (beta < 2.0) return 75 + ((beta - 1.6) / 0.4) * 15;
  return Math.min(100, 90 + (beta - 2) * 5);
}

/** Valuation rerating → 0-100 upside contribution.
 *  Based on PEG ratio proxy: low PE relative to growth = undervalued = re-rating upside.
 *  PEG < 0.5: significantly undervalued → 90. PEG 1.0: fair → 55. PEG 2.5+: overvalued → 10.
 *  If PE or EPS growth unavailable, returns neutral 40.
 */
function normValuationRerating(pe: number | null | undefined, epsGrowth: number | null | undefined): number {
  if (pe == null || epsGrowth == null || epsGrowth <= 0 || pe <= 0) return 40; // neutral
  const peg = pe / epsGrowth;
  if (peg <= 0.3) return 95;
  if (peg <= 0.5) return 90;
  if (peg <= 0.8) return 75;
  if (peg <= 1.0) return 60;
  if (peg <= 1.5) return 50;
  if (peg <= 2.0) return 38;
  if (peg <= 2.5) return 25;
  if (peg <= 4.0) return 15;
  return 8;
}

/** Debt/Equity → 0-100 risk contribution.
 *  0.0: no debt → 5. 1.0: moderate → 45. 3.0+: highly leveraged → 85 */
function normDebtEquityRisk(de: number | null | undefined): number {
  if (de == null) return 40;
  if (de < 0)    return 30; // negative D/E can signal financial stress
  if (de < 0.2)  return 5;
  if (de < 0.6)  return 5 + ((de - 0.2) / 0.4) * 25;
  if (de < 1.5)  return 30 + ((de - 0.6) / 0.9) * 30;
  if (de < 3.0)  return 60 + ((de - 1.5) / 1.5) * 25;
  return Math.min(100, 85 + (de - 3) * 5);
}

// ─── Result interface ─────────────────────────────────────────────────────────
export interface OpportunityResult {
  ticker: string;
  computedAt: string;

  // --- Raw absolute values (shown in expanded rows / tooltips) ---
  rawAnalystUpsidePct: number | null;    // e.g. +47.3 (% to analyst target)
  raw52wHighUpsidePct: number | null;    // e.g. +18.2 (% to 52w high)
  rawRevenueGrowthPct: number | null;    // e.g. +22.5 (% YoY revenue growth)
  rawEpsGrowthPct: number | null;        // e.g. +31.0 (% YoY EPS growth)
  rawDrawdownRiskPct: number | null;     // e.g. 34.5 (% drop back to 52w low)
  rawAtrPct: number | null;              // e.g. 2.4 (ATR as % of price)
  rawBeta: number | null;                // e.g. 1.35
  rawDebtEquity: number | null;          // e.g. 0.82
  thematicMultiplier: number;            // 1.0–1.5x

  // --- Component scores (0-100, before thematic multiplier) ---
  upsideAnalystTarget: number;
  upside52wHigh: number;
  upsideRevenueGrowth: number;
  upsideEpsGrowth: number;
  upsideValuationRerating: number;

  riskDrawdown: number;
  riskAtr: number;
  riskBeta: number;
  riskDebtEquity: number;

  // --- Composite scores per horizon (0-100+, absolute) ---
  // upsideScore and riskScore are at the default "3y" horizon for backward compat
  upsideScore: number;
  riskScore: number;
  themeTags: string[];

  // Horizon-keyed scores { "1y": {...}, "3y": {...}, ... }
  horizonScores: Record<string, { upsideScore: number; riskScore: number; compositeScore: number }>;
}

// ─── Main compute function ────────────────────────────────────────────────────
export function computeOpportunityScore(
  raw: RawStockData,
  name: string,
  sector: string | null,
  industry: string | null
): OpportunityResult {
  const themeMatches = assignThemesWithStrength(raw.ticker, name, sector, industry);
  const themes = themeMatches.map((m) => m.theme);
  const multiplier = computeThematicMultiplier(themeMatches);

  // --- Raw absolute values ---
  const rawAnalystUpside = calcAnalystUpsidePct(raw.price, raw.priceTarget);
  const raw52wHighUpside = calc52wHighUpsidePct(raw.price, raw.high52w);
  const rawDrawdown = calcDrawdownRiskPct(raw.price, raw.low52w);
  const rawAtr = calcAtrPct(raw.atr14, raw.price);

  // --- Normalised component scores (0–100) ---
  const normAnalyst    = normAnalystUpside(rawAnalystUpside);
  const norm52w        = norm52wUpside(raw52wHighUpside);
  const normRevenue    = normRevenueGrowth(raw.revenueGrowthYoy);
  const normEps        = normEpsGrowth(raw.epsGrowthYoy);
  const normValRerate  = normValuationRerating(raw.pe, raw.epsGrowthYoy);

  const normDrawdown = normDrawdownRisk(rawDrawdown);
  const normAtr      = normAtrRisk(rawAtr);
  const normBeta     = normBetaRisk(raw.beta);
  const normDebt     = normDebtEquityRisk(raw.debtEquity);

  // --- Compute composite scores per horizon ---
  const horizonScores: Record<string, { upsideScore: number; riskScore: number; compositeScore: number }> = {};

  for (const [h, profile] of Object.entries(OPPORTUNITY_HORIZON_PROFILES)) {
    const { upsideWeights: uw, riskWeights: rw } = profile;

    // Base upside score (weighted avg of normalised components, 0-100)
    const baseUpside =
      normAnalyst   * uw.analystTarget +
      norm52w       * uw.high52w +
      normRevenue   * uw.revenueCAGR +
      normEps       * uw.epsCAGR +
      normValRerate * uw.valuationRerating +
      (themes.length > 0 ? 70 : 30) * uw.thematic; // thematic base: 70 if has themes, 30 if not

    // Apply thematic multiplier to full upside score (capped at 100)
    const upsideScore = Math.min(100, Math.round(baseUpside * multiplier * 10) / 10);

    // Risk score (weighted avg, 0-100, higher = more risky)
    const riskScore = Math.round(
      (normDrawdown * rw.drawdown +
       normAtr      * rw.atrPct +
       normBeta     * rw.beta +
       normDebt     * rw.debtEquity) * 10
    ) / 10;

    // Composite: upside with risk penalty (higher upside + lower risk = better)
    // At long horizons the risk penalty is smaller since volatility averages out
    const riskPenaltyFactor = h === "20y" ? 0.12 : h === "10y" ? 0.15 : h === "5y" ? 0.20 : h === "3y" ? 0.25 : 0.30;
    const compositeScore = Math.round(
      Math.max(0, Math.min(100, upsideScore - riskScore * riskPenaltyFactor)) * 10
    ) / 10;

    horizonScores[h] = { upsideScore, riskScore, compositeScore };
  }

  // Default to 3y for backward compat fields
  const defaults = horizonScores["3y"];

  return {
    ticker: raw.ticker,
    computedAt: new Date().toISOString(),

    // Raw absolute values
    rawAnalystUpsidePct: rawAnalystUpside !== null ? Math.round(rawAnalystUpside * 10) / 10 : null,
    raw52wHighUpsidePct: raw52wHighUpside !== null ? Math.round(raw52wHighUpside * 10) / 10 : null,
    rawRevenueGrowthPct: raw.revenueGrowthYoy !== null && raw.revenueGrowthYoy !== undefined
      ? Math.round(raw.revenueGrowthYoy * 10) / 10 : null,
    rawEpsGrowthPct: raw.epsGrowthYoy !== null && raw.epsGrowthYoy !== undefined
      ? Math.round(raw.epsGrowthYoy * 10) / 10 : null,
    rawDrawdownRiskPct: rawDrawdown !== null ? Math.round(rawDrawdown * 10) / 10 : null,
    rawAtrPct: rawAtr !== null ? Math.round(rawAtr * 100) / 100 : null,
    rawBeta: raw.beta !== null && raw.beta !== undefined ? Math.round(raw.beta * 100) / 100 : null,
    rawDebtEquity: raw.debtEquity !== null && raw.debtEquity !== undefined
      ? Math.round(raw.debtEquity * 100) / 100 : null,
    thematicMultiplier: Math.round(multiplier * 100) / 100,

    // Component scores
    upsideAnalystTarget:     Math.round(normAnalyst * 10) / 10,
    upside52wHigh:           Math.round(norm52w * 10) / 10,
    upsideRevenueGrowth:     Math.round(normRevenue * 10) / 10,
    upsideEpsGrowth:         Math.round(normEps * 10) / 10,
    upsideValuationRerating: Math.round(normValRerate * 10) / 10,

    riskDrawdown:    Math.round(normDrawdown * 10) / 10,
    riskAtr:         Math.round(normAtr * 10) / 10,
    riskBeta:        Math.round(normBeta * 10) / 10,
    riskDebtEquity:  Math.round(normDebt * 10) / 10,

    // Composite scores (3y default for backward compat)
    upsideScore: defaults.upsideScore,
    riskScore: defaults.riskScore,
    themeTags: themes,

    horizonScores,
  };
}
