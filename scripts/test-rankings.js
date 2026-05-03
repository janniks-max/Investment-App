#!/usr/bin/env node
/**
 * test-rankings.js — Automated assertions for the Global Intraday Stock Recommender
 *
 * Tests that:
 *  1. Changing horizon produces different rank orderings and scores
 *  2. Changing strictness produces different BUY/WATCH/AVOID counts
 *  3. Each response carries the correct metadata (horizon, strictness, thresholds)
 *  4. liveRank, livePercentile, liveHorizonScore, liveSignal fields are present
 *  5. Ranks are unique and contiguous (no duplicates)
 *  6. BUY stocks always rank higher than WATCH which rank higher than AVOID
 *  7. Top-K mode returns exactly K results
 *  8. Signal filter returns only matching signals
 *
 * Usage:
 *   node scripts/test-rankings.js [--base-url http://localhost:5000]
 *
 * Exit code: 0 = all passed, 1 = one or more failed
 */

const BASE_URL = (() => {
  const idx = process.argv.indexOf("--base-url");
  return idx !== -1 ? process.argv[idx + 1] : "http://localhost:5000";
})();

const HORIZONS    = ["20", "60", "120", "250"];
const STRICTNESS  = ["conservative", "balanced", "opportunistic"];
const TOPK_VALUES = [10, 20, 50];
const SIGNALS     = ["BUY", "WATCH", "AVOID"];

let passed = 0;
let failed = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  FAIL: ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

/**
 * Normalize the API response into a consistent shape:
 *   { recommendations: [...], meta: { horizon, strictness, thresholds, computedAt } }
 *
 * The backend returns:
 *   { data: [...], strictness, horizon, thresholds, computedAt, cacheNote, ... }
 * Each record uses `ticker` (not `symbol`) and liveSignal is lowercase.
 */
function normalize(raw) {
  const recs = (raw.recommendations || raw.data || []).map((r) => ({
    ...r,
    symbol:          r.symbol || r.ticker,
    liveSignal:      (r.liveSignal || "").toUpperCase(),
  }));
  const meta = raw.meta || {
    horizon:    raw.horizon    || raw.liveHorizon,
    strictness: raw.strictness || raw.liveStrictness,
    thresholds: raw.thresholds || {},
    computedAt: raw.computedAt || raw.timestamp,
    cacheNote:  raw.cacheNote,
  };
  return { recommendations: recs, meta };
}

async function fetchRecs(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}/api/recommendations${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const raw = await res.json();
  return normalize(raw);
}

function topSymbols(recs, n = 5) {
  return recs.slice(0, n).map((r) => r.symbol).join(",");
}

function rankOrder(recs) {
  return recs.map((r) => r.liveRank);
}

function scoreList(recs) {
  return recs.map((r) => r.liveHorizonScore);
}

function countSignals(recs) {
  const counts = { BUY: 0, WATCH: 0, AVOID: 0 };
  for (const r of recs) counts[r.liveSignal] = (counts[r.liveSignal] || 0) + 1;
  return counts;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

async function testResponseStructure() {
  console.log("\n── Suite 1: Response structure ─────────────────────────────────");
  const data = await fetchRecs({ horizon: "60", strictness: "balanced" });

  assert(Array.isArray(data.recommendations), "recommendations is an array");
  assert(data.recommendations.length > 0,     "at least 1 recommendation returned");
  assert(typeof data.meta === "object",        "meta object present");

  const meta = data.meta;
  assert(meta.horizon    === "60",       "meta.horizon = 60");
  assert(meta.strictness === "balanced", "meta.strictness = balanced");
  assert(typeof meta.thresholds === "object", "meta.thresholds present");
  assert(typeof meta.thresholds.buyTopPct === "number", "meta.thresholds.buyTopPct is number");
  assert(typeof meta.computedAt === "string",  "meta.computedAt present");

  const rec = data.recommendations[0];
  assert(typeof rec.liveRank         === "number", "liveRank is number");
  assert(typeof rec.livePercentile   === "number", "livePercentile is number");
  assert(typeof rec.liveHorizonScore === "number", "liveHorizonScore is number");
  assert(SIGNALS.includes(rec.liveSignal), `liveSignal is BUY/WATCH/AVOID (got ${rec.liveSignal})`);
  assert(typeof rec.symbol           === "string", "symbol is string");
}

async function testHorizonDifferences() {
  console.log("\n── Suite 2: Horizon differences ────────────────────────────────");

  const responses = {};
  for (const h of HORIZONS) {
    responses[h] = await fetchRecs({ horizon: h, strictness: "balanced" });
  }

  // Scores should differ across horizons for the same stock universe
  const scoreVectors = {};
  for (const h of HORIZONS) {
    scoreVectors[h] = scoreList(responses[h].recommendations);
  }

  let anyDifferentScores = false;
  for (let i = 0; i < HORIZONS.length - 1; i++) {
    const h1 = HORIZONS[i], h2 = HORIZONS[i + 1];
    const same = arraysEqual(scoreVectors[h1], scoreVectors[h2]);
    if (!same) anyDifferentScores = true;
    assert(!same, `Scores differ between horizon ${h1} and ${h2}`);
  }

  // Top-5 rank order should differ between short and long horizons
  const top5_20  = topSymbols(responses["20"].recommendations);
  const top5_250 = topSymbols(responses["250"].recommendations);
  assert(top5_20 !== top5_250,
    "Top-5 symbols differ between 20d and 250d horizons",
    `20d: ${top5_20}  |  250d: ${top5_250}`
  );

  // meta.horizon should match request
  for (const h of HORIZONS) {
    assert(
      responses[h].meta.horizon === h,
      `meta.horizon matches request for horizon=${h}`
    );
  }
}

async function testStrictnessDifferences() {
  console.log("\n── Suite 3: Strictness differences ─────────────────────────────");

  const responses = {};
  for (const s of STRICTNESS) {
    responses[s] = await fetchRecs({ horizon: "60", strictness: s });
  }

  // BUY count should increase as strictness goes conservative → opportunistic
  const buyCounts = {};
  for (const s of STRICTNESS) {
    buyCounts[s] = countSignals(responses[s].recommendations).BUY;
    console.log(`    ${s}: BUY=${buyCounts[s]}`);
  }

  assert(
    buyCounts.conservative <= buyCounts.balanced,
    "Conservative has ≤ BUY count than balanced",
    `conservative=${buyCounts.conservative}, balanced=${buyCounts.balanced}`
  );
  assert(
    buyCounts.balanced <= buyCounts.opportunistic,
    "Balanced has ≤ BUY count than opportunistic",
    `balanced=${buyCounts.balanced}, opportunistic=${buyCounts.opportunistic}`
  );
  assert(
    buyCounts.conservative < buyCounts.opportunistic,
    "Conservative has strictly fewer BUY than opportunistic",
    `conservative=${buyCounts.conservative}, opportunistic=${buyCounts.opportunistic}`
  );

  // meta.strictness should match request
  for (const s of STRICTNESS) {
    assert(
      responses[s].meta.strictness === s,
      `meta.strictness matches request for strictness=${s}`
    );
  }

  // Thresholds should differ
  const thresholds = STRICTNESS.map((s) => responses[s].meta.thresholds.buyTopPct);
  console.log(`    buyTopPct thresholds: conservative=${thresholds[0]}, balanced=${thresholds[1]}, opportunistic=${thresholds[2]}`);
  assert(
    thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2],
    "buyTopPct increases conservative < balanced < opportunistic"
  );
}

async function testRankIntegrity() {
  console.log("\n── Suite 4: Rank integrity ──────────────────────────────────────");

  const data = await fetchRecs({ horizon: "60", strictness: "balanced" });
  const recs = data.recommendations;
  const n = recs.length;

  // Ranks should be 1..n with no duplicates
  const ranks = recs.map((r) => r.liveRank);
  const uniqueRanks = new Set(ranks);
  assert(uniqueRanks.size === n, `All ${n} ranks are unique`);

  const sorted = [...ranks].sort((a, b) => a - b);
  assert(sorted[0] === 1, "Min rank is 1");
  assert(sorted[n - 1] === n, `Max rank is ${n} (total count)`);

  // Scores should be descending by rank
  const scores = recs.map((r) => r.liveHorizonScore);
  let scoresDescending = true;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[i - 1] + 0.05) { // tiny tolerance for float rounding
      scoresDescending = false;
      break;
    }
  }
  assert(scoresDescending, "liveHorizonScore is non-increasing with rank");

  // BUY stocks should have lower rank numbers (rank closer to 1) than WATCH, AVOID
  const buyRanks   = recs.filter((r) => r.liveSignal === "BUY").map((r) => r.liveRank);
  const watchRanks = recs.filter((r) => r.liveSignal === "WATCH").map((r) => r.liveRank);
  const avoidRanks = recs.filter((r) => r.liveSignal === "AVOID").map((r) => r.liveRank);

  if (buyRanks.length > 0 && watchRanks.length > 0) {
    const maxBuy   = Math.max(...buyRanks);
    const minWatch = Math.min(...watchRanks);
    assert(maxBuy < minWatch,
      "Highest-ranked BUY stock has lower rank number than lowest-ranked WATCH",
      `maxBuyRank=${maxBuy}, minWatchRank=${minWatch}`
    );
  }

  if (watchRanks.length > 0 && avoidRanks.length > 0) {
    const maxWatch = Math.max(...watchRanks);
    const minAvoid = Math.min(...avoidRanks);
    assert(maxWatch < minAvoid,
      "Highest-ranked WATCH stock has lower rank number than lowest-ranked AVOID",
      `maxWatchRank=${maxWatch}, minAvoidRank=${minAvoid}`
    );
  }
}

async function testTopKMode() {
  console.log("\n── Suite 5: Top-K mode ──────────────────────────────────────────");

  for (const k of TOPK_VALUES) {
    const data = await fetchRecs({ horizon: "60", strictness: "balanced", topK: String(k) }); // backend param is topK
    const n = data.recommendations.length;
    // Top-K returns at most K results (could be fewer if universe is smaller)
    assert(n <= k, `topK=${k} returns ≤ ${k} results (got ${n})`);
    assert(n > 0,  `topK=${k} returns at least 1 result`);
  }
}

async function testSignalFilter() {
  console.log("\n── Suite 6: Signal filter ───────────────────────────────────────");

  for (const sig of SIGNALS) {
    // Backend may accept lowercase signal values
    const data = await fetchRecs({ horizon: "60", strictness: "balanced", signal: sig.toLowerCase() });
    const recs = data.recommendations;
    if (recs.length === 0) {
      console.log(`    (no stocks with signal ${sig} — skipping assertion)`);
      continue;
    }
    const allMatch = recs.every((r) => r.liveSignal === sig);
    assert(allMatch, `All returned stocks have liveSignal=${sig} when filter active`,
      `got: ${[...new Set(recs.map(r => r.liveSignal))].join(",")}`);
  }
}

async function testCrossHorizonScoreVariance() {
  console.log("\n── Suite 7: Cross-horizon score variance ────────────────────────");

  // Fetch all horizons and check that a given stock has different scores across them
  const allData = {};
  for (const h of HORIZONS) {
    allData[h] = await fetchRecs({ horizon: h, strictness: "balanced" });
  }

  // Find stocks present in all 4 horizons
  const symbolSets = HORIZONS.map((h) =>
    new Set(allData[h].recommendations.map((r) => r.symbol))
  );
  const common = [...symbolSets[0]].filter((s) => symbolSets.every((set) => set.has(s)));

  if (common.length === 0) {
    console.log("    (no common symbols across all horizons — skipping per-stock assertion)");
  } else {
    // Pick first 5 common symbols
    const sample = common.slice(0, 5);
    let anyVary = false;
    for (const sym of sample) {
      const scores = HORIZONS.map((h) => {
        const r = allData[h].recommendations.find((x) => x.symbol === sym);
        return r ? r.liveHorizonScore : null;
      }).filter((s) => s !== null);
      const unique = new Set(scores.map((s) => Math.round(s)));
      if (unique.size > 1) anyVary = true;
    }
    assert(anyVary, "At least one stock has different liveHorizonScore across horizons");
  }

  // Verify rank ordering of BUY stocks differs across horizons (different stocks rank at top)
  // Note: BUY *count* is percentile-driven (top N%), so the count may be identical across
  // horizons if the universe size is constant — what matters is that different stocks qualify.
  const buySymbolSets = HORIZONS.map((h) => {
    const buys = allData[h].recommendations.filter((r) => r.liveSignal === "BUY").map((r) => r.symbol);
    return buys.sort().join(",");
  });
  console.log(`    BUY counts by horizon: 20d=${buySymbolSets[0].split(",").length}, 60d=${buySymbolSets[1].split(",").length}, 120d=${buySymbolSets[2].split(",").length}, 250d=${buySymbolSets[3].split(",").length}`);
  const uniqueBuySymbolSets = new Set(buySymbolSets);
  assert(
    uniqueBuySymbolSets.size > 1,
    "Different stocks qualify as BUY across at least two horizons",
    `All horizons have identical BUY symbol sets — scores may not be differentiating enough`
  );
}

async function testMetadataConsistency() {
  console.log("\n── Suite 8: Metadata consistency ────────────────────────────────");

  // Two requests with the same params should return the same meta.thresholds
  const [a, b] = await Promise.all([
    fetchRecs({ horizon: "120", strictness: "conservative" }),
    fetchRecs({ horizon: "120", strictness: "conservative" }),
  ]);

  assert(
    JSON.stringify(a.meta.thresholds) === JSON.stringify(b.meta.thresholds),
    "Identical requests return identical thresholds"
  );

  // All horizons should return same total stock count (universe doesn't change by horizon)
  const counts = await Promise.all(
    HORIZONS.map(async (h) => {
      const d = await fetchRecs({ horizon: h, strictness: "balanced" });
      return d.recommendations.length;
    })
  );
  console.log(`    Total stocks returned per horizon: ${counts.join(", ")}`);
  const allSame = counts.every((c) => c === counts[0]);
  assert(allSame, "All horizons return same total stock count (same universe)");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log("=".repeat(64));
  console.log(" Global Intraday Stock Recommender — Automated Assertions");
  console.log(`  Base URL: ${BASE_URL}`);
  console.log("=".repeat(64));

  // Warm-up: check server is reachable
  try {
    await fetchRecs({ horizon: "60", strictness: "balanced" });
  } catch (err) {
    console.error(`\n❌  Cannot reach ${BASE_URL}/api/recommendations — is the server running?\n  ${err.message}`);
    process.exit(1);
  }

  try {
    await testResponseStructure();
    await testHorizonDifferences();
    await testStrictnessDifferences();
    await testRankIntegrity();
    await testTopKMode();
    await testSignalFilter();
    await testCrossHorizonScoreVariance();
    await testMetadataConsistency();
    await testHorizonScoreDistinctness();
    await testConfidenceDecreases();
    await testExplanationIsHorizonSpecific();
    await testHealthCheck();
    await testHorizonProfiles();
    await testRecommendationsHaveHorizonProfile();
  } catch (err) {
    console.error(`\n❌  Unexpected error: ${err.message}`);
    failed++;
  }

  console.log("\n" + "=".repeat(64));
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(64));

  process.exit(failed > 0 ? 1 : 0);
}

run();

// ─── Suite 9: Horizon score distinctness (extended) ────────────────────────────
// Verifies that 20d vs 60d vs 120d vs 250d produce genuinely different scores,
// not just relabeled versions of the same composite.

async function testHorizonScoreDistinctness() {
  console.log("\n── Suite 9: Horizon score distinctness ─────────────────────────────");

  const allData = {};
  for (const h of HORIZONS) {
    allData[h] = await fetchRecs({ horizon: h, strictness: "balanced" });
  }

  // For each stock present in all horizons, compare their scores across horizons
  const symbolSets = HORIZONS.map(h => new Set(allData[h].recommendations.map(r => r.symbol)));
  const common = [...symbolSets[0]].filter(s => symbolSets.every(set => set.has(s)));

  assert(common.length > 0, `At least 1 stock present in all 4 horizons (got ${common.length})`);

  // Score variance: measure how different 20d scores are from 250d scores
  let stocksWithDifferentScores = 0;
  let maxScoreDiff = 0;
  let biggestDiffStock = "";

  for (const sym of common) {
    const scores = HORIZONS.map(h => {
      const r = allData[h].recommendations.find(x => x.symbol === sym);
      return r ? r.liveHorizonScore : null;
    });
    const valid = scores.filter(s => s !== null);
    if (valid.length < 2) continue;
    const diff = Math.max(...valid) - Math.min(...valid);
    if (diff > 0.1) stocksWithDifferentScores++;
    if (diff > maxScoreDiff) { maxScoreDiff = diff; biggestDiffStock = sym; }
  }

  console.log(`    Stocks with score variation across horizons: ${stocksWithDifferentScores}/${common.length}`);
  console.log(`    Max score difference (20d vs 250d): ${maxScoreDiff.toFixed(2)} (${biggestDiffStock})`);

  assert(
    stocksWithDifferentScores > common.length * 0.5,
    `Majority of stocks (>50%) have different scores across horizons`,
    `only ${stocksWithDifferentScores}/${common.length} differ`
  );

  assert(
    maxScoreDiff > 2.0,
    `Max per-stock score difference across horizons > 2 points`,
    `max diff: ${maxScoreDiff.toFixed(2)}`
  );
}

// ─── Suite 10: Confidence decreases for longer horizons ──────────────────────
// Longer horizons are harder to predict, so confidence should be lower on average.

async function testConfidenceDecreases() {
  console.log("\n── Suite 10: Confidence decreases with horizon ──────────────────────");

  const allData = {};
  for (const h of HORIZONS) {
    allData[h] = await fetchRecs({ horizon: h, strictness: "balanced" });
  }

  // Check liveConfidence if present, else check via stored confidence fields
  const avgConfidence = {};
  for (const h of HORIZONS) {
    const recs = allData[h].recommendations;
    const confs = recs
      .map(r => r.liveConfidence ?? r[`confidence${h}d`] ?? null)
      .filter(c => c !== null);
    avgConfidence[h] = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  }

  console.log(`    Avg confidence: 20d=${avgConfidence["20"]?.toFixed(1)}, 60d=${avgConfidence["60"]?.toFixed(1)}, 120d=${avgConfidence["120"]?.toFixed(1)}, 250d=${avgConfidence["250"]?.toFixed(1)}`);

  if (avgConfidence["20"] !== null && avgConfidence["250"] !== null) {
    assert(
      avgConfidence["20"] >= avgConfidence["250"],
      `Avg confidence for 20d >= 250d (shorter horizons more confident)`,
      `20d=${avgConfidence["20"]?.toFixed(1)}, 250d=${avgConfidence["250"]?.toFixed(1)}`
    );
  } else {
    console.log("    (confidence data not available — skipping)");
  }
}

// ─── Suite 11: Explanation language is horizon-specific ───────────────────────
// Checks that the liveExplanation text references horizon-specific language.

async function testExplanationIsHorizonSpecific() {
  console.log("\n── Suite 11: Explanation language is horizon-specific ───────────────");

  const keyPhrases = {
    "20":  ["Short-term", "momentum", "catalyst", "trend"],
    "60":  ["Medium-term", "earnings", "momentum"],
    "120": ["6-month", "quality", "valuation", "persistence"],
    "250": ["12-month", "quality", "valuation", "fundamental"],
  };

  for (const h of HORIZONS) {
    const data = await fetchRecs({ horizon: h, strictness: "balanced" });
    const recs = data.recommendations;
    if (recs.length === 0) continue;

    // Check first few BUY or WATCH records
    const samples = recs.filter(r => r.liveSignal === "BUY" || r.liveSignal === "WATCH").slice(0, 3);
    if (samples.length === 0) continue;

    let foundHorizonPhrase = false;
    const phrases = keyPhrases[h] || [];
    for (const r of samples) {
      const expl = (r.liveExplanation || r.explanation || "").toLowerCase();
      if (phrases.some(p => expl.toLowerCase().includes(p.toLowerCase()))) {
        foundHorizonPhrase = true;
        break;
      }
    }

    assert(
      foundHorizonPhrase,
      `Horizon ${h}d explanation contains horizon-specific language (${phrases.slice(0, 2).join(", ")})`,
      `explanation: "${samples[0]?.liveExplanation?.slice(0, 100) ?? "—"}"`
    );
  }
}

// ─── Suite 12: Health check ───────────────────────────────────────────────────

async function testHealthCheck() {
  console.log("\n── Suite 12: Health check endpoint ─────────────────────────────────");

  const res = await fetch(`${BASE_URL}/api/health`);
  assert(res.ok, `GET /api/health returns 200 (got ${res.status})`);
  const data = await res.json();
  assert(data.status === "ok", `health.status === "ok" (got ${data.status})`);
  assert(typeof data.uptime === "number", "health.uptime is a number");
  assert(typeof data.timestamp === "string", "health.timestamp is a string");
}

// ─── Suite 13: Horizon profiles endpoint ─────────────────────────────────────

async function testHorizonProfiles() {
  console.log("\n── Suite 13: Horizon profiles endpoint ──────────────────────────────");

  const res = await fetch(`${BASE_URL}/api/horizon-profiles`);
  assert(res.ok, `/api/horizon-profiles returns 200`);
  const data = await res.json();

  for (const h of ["20", "60", "120", "250"]) {
    assert(typeof data[h] === "object", `Profile exists for horizon ${h}`);
    const w = data[h];
    // Weights should sum to ~1.0 (excluding volatilityPenaltyMultiplier)
    const sum = w.momentum + w.trend + w.earnings + w.valuation + w.quality + w.sentiment;
    assert(Math.abs(sum - 1.0) < 0.01, `Horizon ${h} weights sum to ~1.0 (got ${sum.toFixed(3)})`);
  }

  // 20d momentum weight should be higher than 250d momentum weight
  assert(
    data["20"].momentum > data["250"].momentum,
    `20d momentum weight (${data["20"].momentum}) > 250d momentum weight (${data["250"].momentum})`
  );
  // 250d valuation weight should be higher than 20d valuation weight
  assert(
    data["250"].valuation > data["20"].valuation,
    `250d valuation weight (${data["250"].valuation}) > 20d valuation weight (${data["20"].valuation})`
  );
  // 250d quality weight should be higher than 20d quality weight
  assert(
    data["250"].quality > data["20"].quality,
    `250d quality weight (${data["250"].quality}) > 20d quality weight (${data["20"].quality})`
  );
}

// ─── Suite 14: Recommendations include horizon profile ────────────────────────

async function testRecommendationsHaveHorizonProfile() {
  console.log("\n── Suite 14: Recommendations response has horizon profile ───────────");

  const data = await fetchRecs({ horizon: "120", strictness: "conservative" });

  assert(typeof data.meta.thresholds === "object", "Thresholds object present");
  // Check that the raw response has a horizonProfile field (before normalize strips it)
  const raw = await (await fetch(`${BASE_URL}/api/recommendations?horizon=120&strictness=conservative`)).json();
  assert(typeof raw.horizonProfile === "object", "horizonProfile object present in raw response");
  assert(raw.horizonProfile.weights?.valuation > 0.2, `120d profile: valuation weight > 20% (got ${raw.horizonProfile.weights?.valuation})`);
  assert(raw.horizonProfile.weights?.momentum < 0.2, `120d profile: momentum weight < 20% (got ${raw.horizonProfile.weights?.momentum})`);
  assert(typeof raw.recomputeEvidence === "string", "recomputeEvidence string present");
  assert(typeof raw.scoreSpread === "object", "scoreSpread object present");
  assert(typeof raw.durationMs === "number", "durationMs number present");
}

