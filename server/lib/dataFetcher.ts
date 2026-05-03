/**
 * Data Fetcher
 * Primary source: Yahoo Finance v8/finance/chart (public, no API key needed, ~15min delay)
 * Fallback: Alpha Vantage (requires free API key)
 *
 * Anti-hallucination: only stores data actually returned from API.
 * Missing fields are stored as null — never invented.
 */

import axios from "axios";

import { getFxRates, convertPrice } from "./fxRates";

export interface RawStockData {
  ticker: string;
  source: string;
  freshness: "realtime" | "delayed" | "eod";
  fetchedAt: string;
  error?: string;
  // Company identity (from Yahoo meta)
  longName?: string;
  shortName?: string;
  exchangeName?: string;
  quoteType?: string;
  // Price
  price?: number;
  nativeCurrency?: string;  // raw Yahoo currency code (KRW, JPY, GBp, EUR, USD…)
  priceEur?: number;        // price converted to EUR via direct FX pair
  priceUsd?: number;        // price converted to USD via direct FX pair
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  volume?: number;
  avgVolume20d?: number;
  // Technicals
  sma20?: number;
  sma50?: number;
  sma200?: number;
  ema12?: number;
  ema26?: number;
  rsi14?: number;
  macd?: number;
  macdSignal?: number;
  atr14?: number;
  beta?: number;
  // 52w
  high52w?: number;
  low52w?: number;
  // Returns (computed from historical)
  ret1d?: number;
  ret5d?: number;
  ret20d?: number;
  ret60d?: number;
  ret120d?: number;
  ret250d?: number;
  // Fundamentals
  pe?: number;
  pb?: number;
  ps?: number;
  evEbitda?: number;
  eps?: number;
  epsGrowthYoy?: number;
  revenueGrowthYoy?: number;
  grossMargin?: number;
  operatingMargin?: number;
  roe?: number;
  debtEquity?: number;
  freeCashFlow?: number;
  dividendYield?: number;
  shortPercentOfFloat?: number;
  marketCap?: number;
  // Analyst
  analystBuy?: number;
  analystHold?: number;
  analystSell?: number;
  priceTarget?: number;
  earningsDate?: string;
  // Sentiment
  sentimentScore?: number;
  newsCount24h?: number;
  recentInsiderBuy?: boolean; // open-market buy in last 14 days
  // Raw
  rawJson?: string;
}

const YAHOO_BASE = "https://query1.finance.yahoo.com";

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/",
};

// ─── Yahoo crumb/cookie cache (session-level, re-acquired on failure) ─────────
let _yahooCrumb: string | null = null;
let _yahooCookie: string | null = null;
let _crumbFetchedAt = 0;
const CRUMB_TTL_MS = 55 * 60 * 1000; // 55 minutes

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  const now = Date.now();
  if (_yahooCrumb && _yahooCookie && (now - _crumbFetchedAt) < CRUMB_TTL_MS) {
    return { crumb: _yahooCrumb, cookie: _yahooCookie };
  }
  try {
    // Use fc.yahoo.com to get a session cookie — returns minimal headers, no CSP bloat
    const cookieResp = await axios.get("https://fc.yahoo.com", {
      headers: { "User-Agent": YAHOO_HEADERS["User-Agent"] },
      timeout: 8000,
      maxRedirects: 3,
      validateStatus: () => true,
    });
    const setCookie = cookieResp.headers["set-cookie"] as string[] | string | undefined;
    const cookies: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const cookieStr = cookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    if (!cookieStr) return null;

    // Fetch crumb — retry up to 3x on rate-limit (getcrumb returns "Too Many Requests" as body)
    let crumb: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
      const crumbResp = await axios.get(`${YAHOO_BASE}/v1/test/getcrumb`, {
        headers: { ...YAHOO_HEADERS, "Cookie": cookieStr },
        timeout: 8000,
        validateStatus: () => true,
      });
      const raw = typeof crumbResp.data === "string" ? crumbResp.data.trim() : null;
      // Reject non-crumb responses: JSON bodies, rate-limit messages, or anything with spaces
      if (raw && !raw.startsWith("{") && !raw.includes(" ") && raw.length <= 50) {
        crumb = raw;
        break;
      }
    }
    if (!crumb) return null;

    _yahooCrumb = crumb;
    _yahooCookie = cookieStr;
    _crumbFetchedAt = now;
    return { crumb, cookie: cookieStr };
  } catch {
    return null;
  }
}

// EMA helper
function computeEma(data: number[], n: number): number {
  const k = 2 / (n + 1);
  return data.reduce((prev, cur) => cur * k + prev * (1 - k));
}

// SMA helper
function computeSma(data: number[], n: number): number | undefined {
  const slice = data.slice(-n);
  if (slice.length < n) return undefined;
  return slice.reduce((a, b) => a + b, 0) / n;
}

async function fetchYahooChart(ticker: string): Promise<RawStockData> {
  const now = new Date().toISOString();

  try {
    // Primary: 1-year daily data with fundamentals
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y&includePrePost=false&events=div%2Csplits`;
    const resp = await axios.get(url, {
      headers: YAHOO_HEADERS,
      timeout: 15000,  // Increased for international/Asian exchanges
    });

    const result = resp.data?.chart?.result?.[0];
    if (!result) throw new Error("Empty chart response");

    const meta = result.meta || {};

    // ─── Extract company identity from meta (fixes Asian/international names) ──
    const rawLongName  = (meta.longName  as string | undefined)?.trim();
    const rawShortName = (meta.shortName as string | undefined)?.trim();
    const rawExchangeName = (meta.fullExchangeName as string | undefined) ||
                            (meta.exchangeName as string | undefined);
    const rawQuoteType = (meta.quoteType as string | undefined);

    const quotes = result.indicators?.quote?.[0] || {};
    const rawCloses = (quotes.close as (number | null)[]) || [];
    const rawHighs = (quotes.high as (number | null)[]) || [];
    const rawLows = (quotes.low as (number | null)[]) || [];
    const rawVolumes = (quotes.volume as (number | null)[]) || [];
    const rawOpens = (quotes.open as (number | null)[]) || [];

    // Filter out null values but keep indices
    const closes = rawCloses.filter((v): v is number => v !== null && v > 0);
    const highs = rawHighs.filter((v): v is number => v !== null && v > 0);
    const lows = rawLows.filter((v): v is number => v !== null && v > 0);
    const volumes = rawVolumes.filter((v): v is number => v !== null && v >= 0);

    const currentPrice = meta.regularMarketPrice;
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const nativeCurrency: string | undefined = (meta.currency as string | undefined) || undefined;

    const raw: RawStockData = {
      ticker,
      source: "yahoo_chart",
      freshness: "delayed",
      fetchedAt: now,
      longName:     rawLongName  || undefined,
      shortName:    rawShortName || undefined,
      exchangeName: rawExchangeName || undefined,
      quoteType:    rawQuoteType || undefined,
      price: currentPrice ?? lastClose,
      nativeCurrency,
      open: rawOpens.filter((v): v is number => v !== null && v > 0).slice(-1)[0],
      high: meta.regularMarketDayHigh ?? highs.slice(-1)[0],
      low: meta.regularMarketDayLow ?? lows.slice(-1)[0],
      prevClose: prevClose,
      change: currentPrice && prevClose ? currentPrice - prevClose : undefined,
      changePct: currentPrice && prevClose ? ((currentPrice - prevClose) / prevClose) * 100 : undefined,
      volume: meta.regularMarketVolume,
      high52w: meta.fiftyTwoWeekHigh,
      low52w: meta.fiftyTwoWeekLow,
    };

    // ─── Computed from price series ──────────────────────────────────────────

    if (closes.length >= 2) {
      const cur = closes[closes.length - 1];
      const getClose = (n: number) => closes.length > n ? closes[closes.length - 1 - n] : null;

      raw.ret1d = getClose(1) ? ((cur - getClose(1)!) / getClose(1)!) * 100 : undefined;
      raw.ret5d = getClose(5) ? ((cur - getClose(5)!) / getClose(5)!) * 100 : undefined;
      raw.ret20d = getClose(20) ? ((cur - getClose(20)!) / getClose(20)!) * 100 : undefined;
      raw.ret60d = getClose(60) ? ((cur - getClose(60)!) / getClose(60)!) * 100 : undefined;
      raw.ret120d = getClose(120) ? ((cur - getClose(120)!) / getClose(120)!) * 100 : undefined;
      raw.ret250d = getClose(250) ? ((cur - getClose(250)!) / getClose(250)!) * 100 : undefined;

      // SMAs
      raw.sma20 = computeSma(closes, 20);
      raw.sma50 = computeSma(closes, 50);
      raw.sma200 = computeSma(closes, 200);

      // EMAs and MACD
      if (closes.length >= 26) {
        raw.ema12 = computeEma(closes.slice(-12), 12);
        raw.ema26 = computeEma(closes.slice(-26), 26);
        raw.macd = (raw.ema12 || 0) - (raw.ema26 || 0);
      }

      // RSI-14
      if (closes.length >= 15) {
        const last15 = closes.slice(-15);
        const diffs = last15.slice(1).map((v, i) => v - last15[i]);
        const gains = diffs.map((d) => Math.max(d, 0));
        const losses = diffs.map((d) => Math.max(-d, 0));
        const avgGain = gains.reduce((a, b) => a + b, 0) / 14;
        const avgLoss = losses.reduce((a, b) => a + b, 0) / 14;
        raw.rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }

    // ATR-14
    if (highs.length >= 15 && lows.length >= 15 && closes.length >= 15) {
      const h14 = highs.slice(-14);
      const l14 = lows.slice(-14);
      const c14 = closes.slice(-15, -1); // prev closes
      const trs = h14.map((h, i) => {
        const hl = h - l14[i];
        const hc = Math.abs(h - c14[i]);
        const lc = Math.abs(l14[i] - c14[i]);
        return Math.max(hl, hc, lc);
      });
      raw.atr14 = trs.reduce((a, b) => a + b, 0) / 14;
    }

    // Avg volume 20d
    if (volumes.length >= 20) {
      raw.avgVolume20d = Math.round(volumes.slice(-20).reduce((a, b) => a + b, 0) / 20);
    }

    raw.rawJson = JSON.stringify({ symbol: meta.symbol, longName: rawLongName, shortName: rawShortName, range: "2y", dataPoints: closes.length });

    // ─── Try to get fundamentals from summary endpoint (crumb + 429 retry) ──
    try {
      let summResult: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const auth = await getYahooCrumb();
        const crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
        const summaryUrl = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData,defaultKeyStatistics,summaryDetail,recommendationTrend,earningsTrend,calendarEvents${crumbParam}`;
        const summHeaders: Record<string, string> = { ...YAHOO_HEADERS };
        if (auth?.cookie) summHeaders["Cookie"] = auth.cookie;
        try {
          const summResp = await axios.get(summaryUrl, { headers: summHeaders, timeout: 10000 });
          summResult = summResp.data?.quoteSummary?.result?.[0] ?? null;
          break; // success
        } catch (innerErr: any) {
          const st = innerErr?.response?.status;
          if (st === 429 || st === 503) {
            // Invalidate crumb and back off before retry
            _yahooCrumb = null; _yahooCookie = null; _crumbFetchedAt = 0;
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          } else {
            throw innerErr; // non-retriable — bubble to outer catch
          }
        }
      }

      if (summResult) {
        const fd = summResult.financialData || {};
        const ks = summResult.defaultKeyStatistics || {};
        const sd = summResult.summaryDetail || {};
        const rt = summResult.recommendationTrend?.trend?.[0] || {};
        const et = summResult.earningsTrend?.trend?.[0] || {};
        const ce = summResult.calendarEvents?.earnings || {};

        raw.pe = sd.trailingPE?.raw ?? ks.forwardPE?.raw;
        raw.pb = ks.priceToBook?.raw;
        raw.eps = ks.trailingEps?.raw;
        raw.evEbitda = ks.enterpriseToEbitda?.raw;
        raw.dividendYield = sd.dividendYield?.raw != null ? sd.dividendYield.raw * 100 : undefined;
        raw.beta = sd.beta?.raw ?? ks.beta?.raw;
        raw.roe = fd.returnOnEquity?.raw != null ? fd.returnOnEquity.raw * 100 : undefined;
        raw.grossMargin = fd.grossMargins?.raw != null ? fd.grossMargins.raw * 100 : undefined;
        raw.operatingMargin = fd.operatingMargins?.raw != null ? fd.operatingMargins.raw * 100 : undefined;
        raw.freeCashFlow = fd.freeCashflow?.raw;
        raw.debtEquity = fd.debtToEquity?.raw;
        raw.revenueGrowthYoy = fd.revenueGrowth?.raw != null ? fd.revenueGrowth.raw * 100 : undefined;
        raw.priceTarget = fd.targetMeanPrice?.raw;
        raw.epsGrowthYoy = et.growth?.raw != null ? et.growth.raw * 100 : undefined;
        const buy = (rt.strongBuy || 0) + (rt.buy || 0);
        const hold = rt.hold || 0;
        const sell = (rt.sell || 0) + (rt.strongSell || 0);
        if (buy + hold + sell > 0) {
          raw.analystBuy = buy;
          raw.analystHold = hold;
          raw.analystSell = sell;
        }
        raw.earningsDate = ce.earningsDate?.[0]?.fmt;
        raw.shortPercentOfFloat = ks.shortPercentOfFloat?.raw != null ? ks.shortPercentOfFloat.raw * 100 : undefined;
        raw.marketCap = ks.marketCap?.raw ?? sd.marketCap?.raw;
      }
    } catch (summErr: any) {
      // Fundamentals optional — chart data is sufficient for ranking
      // Invalidate crumb cache on 401/403 so next call re-acquires
      const summStatus = summErr?.response?.status;
      if (summStatus === 401 || summStatus === 403) {
        _yahooCrumb = null;
        _yahooCookie = null;
        _crumbFetchedAt = 0;
      }
      if (raw.rawJson) {
        raw.rawJson += ` | fundError: ${summStatus || summErr?.message}`;
      }
    }

    // ─── FX conversion ─────────────────────────────────────────────────────
    // Convert price to EUR + USD using cached FX rates (non-fatal).
    // Direct pairs only — no chaining. GBp (pence) halved inside convertPrice.
    if (nativeCurrency && raw.price != null) {
      try {
        const rates = await getFxRates();
        const { eur, usd } = convertPrice(raw.price, nativeCurrency, rates);
        if (eur != null) raw.priceEur = eur;
        if (usd != null) raw.priceUsd = usd;
      } catch { /* non-fatal — FX fetch failed */ }
    }

    return raw;
  } catch (err: any) {
    const status = err?.response?.status;
    let errorMsg: string;
    if (status === 404) {
      errorMsg = `Ticker ${ticker} not found on Yahoo Finance (404)`;
    } else if (status === 429 || status === 503) {
      errorMsg = `Rate limited by Yahoo Finance (${status})`;
    } else if (err?.code === "ECONNABORTED" || err?.message?.includes("timeout")) {
      errorMsg = `Network timeout fetching ${ticker}`;
    } else if (err?.code === "ECONNRESET" || err?.code === "ECONNREFUSED") {
      errorMsg = `Network error fetching ${ticker}: ${err.code}`;
    } else {
      errorMsg = err?.message || "Yahoo chart fetch failed";
    }
    return {
      ticker,
      source: "yahoo_chart",
      freshness: "eod",
      fetchedAt: now,
      error: errorMsg,
      rawJson: JSON.stringify({ error: errorMsg, status, code: err?.code }),
    };
  }
}

// Alpha Vantage fallback (requires free key: ALPHAVANTAGE_API_KEY env var)
async function fetchAlphaVantage(ticker: string, apiKey: string): Promise<RawStockData> {
  const now = new Date().toISOString();
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
    const resp = await axios.get(url, { timeout: 8000 });
    const q = resp.data?.["Global Quote"];
    if (!q || !q["05. price"]) throw new Error("No data from Alpha Vantage");

    return {
      ticker,
      source: "alphavantage",
      freshness: "delayed",
      fetchedAt: now,
      price: parseFloat(q["05. price"]),
      open: parseFloat(q["02. open"]),
      high: parseFloat(q["03. high"]),
      low: parseFloat(q["04. low"]),
      prevClose: parseFloat(q["08. previous close"]),
      change: parseFloat(q["09. change"]),
      changePct: parseFloat(q["10. change percent"]?.replace("%", "")),
      volume: parseInt(q["06. volume"]),
      rawJson: JSON.stringify(q),
    };
  } catch (err: any) {
    return {
      ticker,
      source: "alphavantage",
      freshness: "eod",
      fetchedAt: now,
      error: err?.message || "Alpha Vantage fetch failed",
    };
  }
}

// ─── Fix #11B: Stored-value fallback population ──────────────────────────────
// If the live fetch returned a successful price but is missing fundamental
// fields that were previously available, fill them from the most recent stored
// snapshot for that ticker.  This prevents a temporary Yahoo API glitch from
// degrading a stock's data coverage score.
//
// Only fundamental fields that require the quoteSummary endpoint are fallback
// candidates — technicals/price fields are always computed from the chart.
//
// The stored snapshot is injected by routes.ts (which has DB access); this
// function is a pure helper that merges the two objects.
export const FALLBACK_FUNDAMENTAL_FIELDS: Array<keyof RawStockData> = [
  "pe", "pb", "eps", "epsGrowthYoy", "revenueGrowthYoy",
  "grossMargin", "operatingMargin", "roe", "debtEquity",
  "freeCashFlow", "dividendYield", "evEbitda",
  "analystBuy", "analystHold", "analystSell", "priceTarget",
  "earningsDate", "beta", "marketCap",
];

/**
 * Merge stored snapshot values into a freshly-fetched RawStockData for any
 * fundamental field that the live fetch left undefined/null.
 *
 * Returns a new object — neither input is mutated.
 * The `source` field is annotated with "+fallback" if any field was filled.
 */
export function applyStoredFallbacks(
  fresh: RawStockData,
  stored: Partial<RawStockData> | null | undefined
): RawStockData {
  if (!stored) return fresh;

  let anyFilled = false;
  const result = { ...fresh };

  for (const field of FALLBACK_FUNDAMENTAL_FIELDS) {
    if (result[field] === null || result[field] === undefined) {
      const storedVal = stored[field];
      if (storedVal !== null && storedVal !== undefined) {
        (result as any)[field] = storedVal;
        anyFilled = true;
      }
    }
  }

  if (anyFilled) {
    result.source = result.source.includes("+fallback")
      ? result.source
      : result.source + "+fallback";
  }

  return result;
}

export async function fetchStockData(
  ticker: string,
  alphaVantageKey?: string
): Promise<RawStockData> {
  const primary = await fetchYahooChart(ticker);
  if (!primary.error && primary.price) return primary;

  // Try fallback if primary failed and key available
  if (alphaVantageKey) {
    const fallback = await fetchAlphaVantage(ticker, alphaVantageKey);
    if (!fallback.error && fallback.price) {
      return { ...primary, ...fallback, source: "alphavantage_fallback" };
    }
    return { ...primary, error: `Yahoo: ${primary.error}; AV: ${fallback.error}` };
  }

  return primary;
}

export async function fetchBatchStockData(
  tickers: string[],
  alphaVantageKey?: string,
  concurrency = 3
): Promise<RawStockData[]> {
  const results: RawStockData[] = [];
  for (let i = 0; i < tickers.length; i += concurrency) {
    const batch = tickers.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((t) => fetchStockData(t, alphaVantageKey))
    );
    results.push(...batchResults);
    // Rate limiting pause between batches
    if (i + concurrency < tickers.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return results;
}
