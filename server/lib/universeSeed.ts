/**
 * universeSeed.ts
 * Seeds the universe table from the curated ticker-data.json.
 * Called by POST /api/universe/seed endpoint.
 * IMPORTANT: Only populates tickers/metadata — NEVER prices or financials.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { storage } from "../storage";
import type { InsertUniverse } from "../../shared/schema";

// ESM-compatible __dirname
const _filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

interface TickerMeta {
  name: string;
  sector: string;
  industry: string;
  exchange: string;
  country: string;
  region: string;
  currency: string;
}

export async function seedFromTickerData(): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
}> {
  // Try a few paths to find ticker-data.json
  const candidates = [
    path.join(process.cwd(), "scripts", "ticker-data.json"),
    path.join(_dirname, "../../scripts/ticker-data.json"),
    "/app/scripts/ticker-data.json",
  ];

  let tickerData: Record<string, TickerMeta> | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      tickerData = JSON.parse(fs.readFileSync(p, "utf-8"));
      console.log(`[universeSeed] Loaded ticker data from ${p}`);
      break;
    }
  }

  if (!tickerData) {
    throw new Error("ticker-data.json not found. Checked: " + candidates.join(", "));
  }

  const entries = Object.entries(tickerData);
  console.log(`[universeSeed] Seeding ${entries.length} tickers...`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const currentUniverse = await storage.getAllUniverseStocks();
  const existingMap = new Map(currentUniverse.map((u) => [u.ticker, u]));

  for (const [ticker, meta] of entries) {
    try {
      const existing = existingMap.get(ticker);
      const insertData: InsertUniverse = {
        ticker,
        name: meta.name || ticker,
        exchange: meta.exchange || "UNKNOWN",
        country: meta.country || "Unknown",
        region: meta.region || "Unknown",
        currency: meta.currency || "USD",
        sector: meta.sector || null,
        industry: meta.industry || null,
        assetType: "stock",
        isActive: true,
      };

      if (existing) {
        // Update metadata + reactivate if it was soft-deleted
        await storage.addToUniverse(insertData);
        updated++;
      } else {
        await storage.addToUniverse(insertData);
        inserted++;
      }
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        skipped++;
      } else {
        console.warn(`[universeSeed] Error for ${ticker}: ${err?.message}`);
        skipped++;
      }
    }
  }

  const allStocks = await storage.getAllUniverseStocks();
  console.log(`[universeSeed] Done. Inserted: ${inserted}, Updated: ${updated}, Skipped: ${skipped}, Total: ${allStocks.length}`);

  return { inserted, updated, skipped, total: allStocks.length };
}
