/**
 * Sector Classifier — 3-layer fallback
 *
 * Layer 1: Yahoo Finance sector + industry fields
 * Layer 2: Ticker-based manual overrides for known miscategorised stocks
 * Layer 3: Company name keyword matching for Asian/unclassified tickers
 *
 * Canonical sector list (display order):
 *   Technology · Financials · Healthcare · Defense & Aerospace · Industrials
 *   Energy – Oil & Gas · Clean Energy · Nuclear · Automotive · Retail & Leisure
 *   Consumer Staples · Communication Services · Materials · Real Estate
 *   Utilities · Crypto & Digital Assets
 */

export const CANONICAL_SECTORS = [
  "Technology",
  "Financials",
  "Healthcare",
  "Defense & Aerospace",
  "Industrials",
  "Energy – Oil & Gas",
  "Clean Energy",
  "Nuclear",
  "Automotive",
  "Retail & Leisure",
  "Consumer Staples",
  "Communication Services",
  "Materials",
  "Real Estate",
  "Utilities",
  "Crypto & Digital Assets",
] as const;

export type CanonicalSector = (typeof CANONICAL_SECTORS)[number];

// ─── Layer 2: Manual ticker overrides ────────────────────────────────────────
// For stocks Yahoo miscategorises or returns no sector for.

const TICKER_OVERRIDES: Record<string, string> = {
  // Crypto & Digital Assets
  COIN:    "Crypto & Digital Assets",
  MSTR:    "Crypto & Digital Assets",
  MARA:    "Crypto & Digital Assets",
  RIOT:    "Crypto & Digital Assets",
  CLSK:    "Crypto & Digital Assets",
  HUT:     "Crypto & Digital Assets",
  BTBT:    "Crypto & Digital Assets",
  CIFR:    "Crypto & Digital Assets",
  IREN:    "Crypto & Digital Assets",
  WULF:    "Crypto & Digital Assets",

  // Nuclear
  CCJ:     "Nuclear",
  UEC:     "Nuclear",
  NXE:     "Nuclear",
  URG:     "Nuclear",
  UUUU:    "Nuclear",
  DNN:     "Nuclear",
  BWXT:    "Nuclear",
  SMR:     "Nuclear",
  NNE:     "Nuclear",

  // Clean Energy
  ENPH:    "Clean Energy",
  FSLR:    "Clean Energy",
  RUN:     "Clean Energy",
  NEE:     "Clean Energy",
  SEDG:    "Clean Energy",
  ARRY:    "Clean Energy",
  CSIQ:    "Clean Energy",
  JKS:     "Clean Energy",
  PLUG:    "Clean Energy",
  BLNK:    "Clean Energy",
  CHPT:    "Clean Energy",
  BEP:     "Clean Energy",
  CWEN:    "Clean Energy",
  "9RE.DE": "Clean Energy",

  // Defense & Aerospace
  RTX:     "Defense & Aerospace",
  LMT:     "Defense & Aerospace",
  NOC:     "Defense & Aerospace",
  GD:      "Defense & Aerospace",
  BA:      "Defense & Aerospace",
  LDOS:    "Defense & Aerospace",
  BAESY:   "Defense & Aerospace",
  "BA.L":  "Defense & Aerospace",
  "RHM.DE":"Defense & Aerospace",
  "AIR.PA":"Defense & Aerospace",
  "SAF.PA":"Defense & Aerospace",
  HII:     "Defense & Aerospace",
  LHX:     "Defense & Aerospace",
  TDG:     "Defense & Aerospace",
  KTOS:    "Defense & Aerospace",
  "BAYN.DE": "Healthcare",   // Bayer is Healthcare, not defense

  // Automotive
  TSLA:    "Automotive",
  GM:      "Automotive",
  F:       "Automotive",
  STLA:    "Automotive",
  "BMW.DE":"Automotive",
  "MBG.DE":"Automotive",
  "VOW3.DE":"Automotive",
  "RNO.PA":"Automotive",
  "RACE.MI":"Automotive",
  HMC:     "Automotive",
  TM:      "Automotive",
  RIVN:    "Automotive",
  LCID:    "Automotive",
  NIO:     "Automotive",
  LI:      "Automotive",
  XPEV:    "Automotive",
};

// ─── Layer 3: Company name keyword matching ───────────────────────────────────
// Used when sector + industry are both empty/null (common for Asian tickers).
// Keywords are matched case-insensitively against the full company name.

interface NameRule {
  keywords: string[];
  sector: string;
}

const NAME_RULES: NameRule[] = [
  // More specific rules first to avoid false positives
  { keywords: ["nuclear", "uranium", "atomic energy", "nuclear power"], sector: "Nuclear" },
  { keywords: ["solar", "wind energy", "renewable energy", "clean energy"], sector: "Clean Energy" },
  { keywords: ["defense", "defence", "aerospace", "missile", "weapon", "armament", "munition", "ordnance"], sector: "Defense & Aerospace" },
  { keywords: ["semiconductor", "integrated circuit", "microchip"], sector: "Technology" },
  { keywords: ["auto ", "automobile", "automotive", "motor vehicle", "car maker", " ev ", "electric vehicle"], sector: "Automotive" },
  { keywords: ["bank", "banking", "financial", "finance", "insurance", "securities", "asset management", "investment trust", "brokerage", "capital corp", "capital co"], sector: "Financials" },
  { keywords: ["pharma", "pharmaceutical", "biotech", "bioscience", "medical", "hospital", "healthcare", "health care", "drug", "therapeutics", "clinical", "diagnostics"], sector: "Healthcare" },
  { keywords: ["petroleum", "oil & gas", "oil and gas", "oil corp", "oil co", "crude", "refinery", "refining", "lng", "natural gas pipeline"], sector: "Energy – Oil & Gas" },
  { keywords: ["electric power", "electricity", "power co", "power corp", "power generation", "utility", "utilities", "water supply", "gas supply"], sector: "Utilities" },
  { keywords: ["energy", "power", "gas ", " oil "], sector: "Energy – Oil & Gas" },  // broad energy fallback after specific rules
  { keywords: ["telecom", "telecommunications", "wireless", "broadcasting", "media corp", "media co", "television", "cable tv", "satellite tv", "streaming"], sector: "Communication Services" },
  { keywords: ["steel", "mining", "chemical", "materials", "aluminium", "aluminum", "copper", "iron", "zinc", "paper", "packaging", "cement", "glass"], sector: "Materials" },
  { keywords: ["real estate", "reit", "property", "realty", "land corp", "land co", "housing corp"], sector: "Real Estate" },
  { keywords: ["retail", "hotel", "airline", "aviation", "travel", "luxury", "restaurant", "hospitality", "fashion", "apparel", "department store", "supermarket"], sector: "Retail & Leisure" },
  { keywords: ["food", "beverage", "tobacco", "consumer goods", "household", "brewery", "distillery", "dairy"], sector: "Consumer Staples" },
  { keywords: ["software", "tech ", " tech", "technology", "systems corp", "systems co", "electronics", "devices", "instruments", "it solution", "data", "cloud", "digital"], sector: "Technology" },
  { keywords: ["industrial", "machinery", "engineering", "construction equip", "logistics", "transport", "freight", "shipbuilding"], sector: "Industrials" },
];

/**
 * Classify using company name keywords (Layer 3).
 * Returns null if no match found.
 */
function classifyByName(companyName: string | null | undefined): string | null {
  if (!companyName) return null;
  const name = companyName.toLowerCase();
  for (const rule of NAME_RULES) {
    for (const kw of rule.keywords) {
      if (name.includes(kw.toLowerCase())) return rule.sector;
    }
  }
  return null;
}

/**
 * Full 3-layer sector classification.
 *
 * @param yahooSector  - Yahoo Finance `sector` field
 * @param yahooIndustry - Yahoo Finance `industry` field
 * @param ticker       - Stock ticker (for Layer 2 override map)
 * @param companyName  - Company name (for Layer 3 keyword matching)
 */
export function classifySector(
  yahooSector: string | null | undefined,
  yahooIndustry: string | null | undefined,
  ticker?: string | null,
  companyName?: string | null,
): string {
  // ── Layer 2: Ticker override (checked before Yahoo — covers known mis-tags) ──
  if (ticker) {
    const override = TICKER_OVERRIDES[ticker.toUpperCase()] ?? TICKER_OVERRIDES[ticker];
    if (override) return override;
  }

  const sec = (yahooSector ?? "").toLowerCase().trim();
  const ind = (yahooIndustry ?? "").toLowerCase().trim();
  const hasMeta = sec.length > 0 || ind.length > 0;

  // ── Layer 1: Yahoo Finance sector + industry ──────────────────────────────
  if (hasMeta) {
    // Industry-specific checks first (more specific)

    // Crypto & Digital Assets
    if (ind.includes("crypto") || ind.includes("bitcoin") || ind.includes("blockchain") ||
        ind.includes("digital asset") || ind.includes("cryptocurrency")) {
      return "Crypto & Digital Assets";
    }

    // Nuclear
    if (ind.includes("nuclear") || ind.includes("uranium") || ind.includes("reactor")) {
      return "Nuclear";
    }

    // Clean Energy (before generic Energy)
    if (ind.includes("solar") || ind.includes("wind energy") || ind.includes("renewable") ||
        ind.includes("ev charging") || ind.includes("battery") || ind.includes("clean energy") ||
        ind.includes("hydro") || ind.includes("biofuel")) {
      return "Clean Energy";
    }

    // Defense & Aerospace (before Industrials)
    if (ind.includes("aerospace") || ind.includes("defense") || ind.includes("defence") ||
        ind.includes("security & protection") || ind.includes("military") ||
        ind.includes("weapons") || ind.includes("arms") || ind.includes("satellite") ||
        sec.includes("defense")) {
      return "Defense & Aerospace";
    }

    // Automotive (before Consumer Discretionary)
    if (ind.includes("auto manufacturer") || ind.includes("auto part") ||
        ind.includes("motor vehicle") || ind.includes("automobile") ||
        ind.includes("automotive") || ind.includes("car manufacturer") ||
        ind.includes("electric vehicle") || ind.includes("ev maker") ||
        ind === "evs" || ind.includes("auto dealer") || ind.includes("auto & truck")) {
      return "Automotive";
    }

    // Broad sector mapping
    if (sec.includes("technology") || sec.includes("information technology")) return "Technology";
    if (sec.includes("financial")) return "Financials";
    if (sec.includes("healthcare") || sec.includes("health care")) return "Healthcare";

    if (sec.includes("energy") &&
        !ind.includes("solar") && !ind.includes("wind") && !ind.includes("renewable") &&
        !ind.includes("clean") && !ind.includes("nuclear") && !ind.includes("uranium")) {
      return "Energy – Oil & Gas";
    }

    if (sec.includes("utilities")) {
      if (ind.includes("nuclear") || ind.includes("uranium")) return "Nuclear";
      if (ind.includes("solar") || ind.includes("wind") || ind.includes("renewable") ||
          ind.includes("clean") || ind.includes("hydro")) return "Clean Energy";
      return "Utilities";
    }

    if (sec.includes("industrial")) return "Industrials";

    if (sec.includes("consumer discretionary") || sec.includes("consumer cyclical")) {
      if (ind.includes("auto") || ind.includes("vehicle") || ind.includes("motor")) return "Automotive";
      return "Retail & Leisure";
    }

    if (sec.includes("consumer staples") || sec.includes("consumer defensive")) return "Consumer Staples";
    if (sec.includes("communication") || sec.includes("telecom") ||
        sec.includes("media") || sec.includes("entertainment")) return "Communication Services";
    if (sec.includes("material")) return "Materials";
    if (sec.includes("real estate")) return "Real Estate";

    // ETF / broad-market buckets — preserve original casing
    if (sec.includes("broad market") || sec.includes("international") ||
        sec.includes("emerging") || sec.includes("small cap") ||
        sec.includes("commodities")) {
      return yahooSector!;
    }

    // Industry-only fallbacks (sector blank but industry has data)
    if (ind.includes("bank") || ind.includes("insurance") || ind.includes("fintech") ||
        ind.includes("exchange") || ind.includes("payment") || ind.includes("asset management")) return "Financials";
    if (ind.includes("pharma") || ind.includes("biotech") || ind.includes("medtech") ||
        ind.includes("hospital") || ind.includes("diagnostic")) return "Healthcare";
    if (ind.includes("software") || ind.includes("semiconductor") || ind.includes("hardware") ||
        ind.includes("cloud") || ind.includes("it service") || ind.includes("internet")) return "Technology";
    if (ind.includes("telecom") || ind.includes("streaming") || ind.includes("social") ||
        ind.includes("advertis") || ind.includes("broadcast")) return "Communication Services";
    if (ind.includes("mining") || ind.includes("chemical") || ind.includes("steel") ||
        ind.includes("paper") || ind.includes("packaging")) return "Materials";
    if (ind.includes("reit") || ind.includes("property") || ind.includes("real estate")) return "Real Estate";
    if (ind.includes("restaurant") || ind.includes("fashion") || ind.includes("travel") ||
        ind.includes("hotel") || ind.includes("luxury") || ind.includes("e-commerce") ||
        ind.includes("retail") || ind.includes("leisure")) return "Retail & Leisure";
  }

  // ── Layer 3: Company name keyword matching ────────────────────────────────
  const nameResult = classifyByName(companyName);
  if (nameResult) return nameResult;

  // Nothing matched
  return yahooSector || "Other";
}
