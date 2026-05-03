/**
 * FX Rate Cache — fetches direct pairs from Yahoo Finance chart endpoint.
 * Always converts native → target in ONE step (no chaining).
 * Cache TTL: 1 hour.
 */
import axios from "axios";

// Yahoo Finance base
const YAHOO_BASE = "https://query1.finance.yahoo.com";
const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

// Supported direct pairs: <NATIVE>EUR=X and <NATIVE>USD=X
const FX_TICKERS = [
  "USDEUR=X", "USDGBP=X",
  "EURUSD=X", "EURGBP=X",
  "GBPUSD=X", "GBPEUR=X",
  "KRWEUR=X", "KRWUSD=X",
  "JPYEUR=X", "JPYUSD=X",
  "HKDEUR=X", "HKDUSD=X",
  "CNHEUR=X", "CNHUSD=X",
  "AUDEUR=X", "AUDUSD=X",
  "CADEUR=X", "CADUSD=X",
  "CHFEUR=X", "CHFUSD=X",
  "SEKEUR=X", "SEKUSD=X",
  "NOKEUR=X", "NOKUSD=X",
  "DKKEUR=X", "DKKUSD=X",
  "SGDEUR=X", "SGDUSD=X",
  "TWDEUR=X", "TWDUSD=X",
  "INREUR=X", "INRUSD=X",
  "BRLEUR=X", "BRLUSD=X",
];

interface FxCache {
  rates: Record<string, number>; // e.g. { "USDEUR=X": 0.925 }
  fetchedAt: number;
}

let fxCache: FxCache | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchOnePair(symbol: string): Promise<{ symbol: string; rate: number | null }> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const resp = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 8000 });
    const meta = resp.data?.chart?.result?.[0]?.meta;
    const rate = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    return { symbol, rate: rate != null && rate > 0 ? rate : null };
  } catch {
    return { symbol, rate: null };
  }
}

async function fetchFxRates(): Promise<Record<string, number>> {
  const results = await Promise.all(FX_TICKERS.map(fetchOnePair));
  const rates: Record<string, number> = {};
  for (const { symbol, rate } of results) {
    if (rate != null) rates[symbol] = rate;
  }
  console.log(`[FX] Fetched ${Object.keys(rates).length}/${FX_TICKERS.length} rates`);
  return rates;
}

export async function getFxRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (fxCache && now - fxCache.fetchedAt < CACHE_TTL_MS) return fxCache.rates;
  const rates = await fetchFxRates();
  fxCache = { rates, fetchedAt: now };
  return rates;
}

/**
 * Convert a native price to EUR and USD in one step.
 * Returns { eur, usd } — either may be null if rate unavailable.
 * Handles GBp (pence) by dividing by 100 first.
 */
export function convertPrice(
  nativePrice: number,
  nativeCurrency: string,
  rates: Record<string, number>
): { eur: number | null; usd: number | null } {
  // Handle GBp (pence) special case
  let price = nativePrice;
  let currency = nativeCurrency;
  if (currency === "GBp") {
    price = nativePrice / 100;
    currency = "GBP";
  }

  if (currency === "EUR") {
    const usdRate = rates["EURUSD=X"];
    return {
      eur: price,
      usd: usdRate != null ? price * usdRate : null,
    };
  }
  if (currency === "USD") {
    const eurRate = rates["USDEUR=X"];
    return {
      eur: eurRate != null ? price * eurRate : null,
      usd: price,
    };
  }

  // All other currencies: use direct pairs
  const eurKey = `${currency}EUR=X`;
  const usdKey = `${currency}USD=X`;
  return {
    eur: rates[eurKey] != null ? price * rates[eurKey] : null,
    usd: rates[usdKey] != null ? price * rates[usdKey] : null,
  };
}

/**
 * Apply convertPrice to any absolute monetary value
 * (market cap, FCF, revenue, transaction value, etc.)
 */
export function convertMonetary(
  value: number | null | undefined,
  nativeCurrency: string,
  rates: Record<string, number>
): { eur: number | null; usd: number | null } {
  if (value == null) return { eur: null, usd: null };
  return convertPrice(value, nativeCurrency, rates);
}
