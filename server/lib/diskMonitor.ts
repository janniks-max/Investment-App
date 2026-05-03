/**
 * Disk usage monitoring and automatic pruning for the Railway volume.
 *
 * Responsibilities:
 *  - Startup check: log volume usage, warn at 20%, auto-cleanup at 5%
 *  - WAL guard: checkpoint immediately if WAL file exceeds 50 MB
 *  - Scheduled daily pruning of all tables + WAL checkpoint after
 *  - GET /api/admin/disk-usage metrics
 */

import fs from "fs";
import path from "path";
import { rawSqlite as sqlite } from "../storage";

// ─── Paths ────────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH ?? "/app/data/stock-recommender.db";
const DATA_DIR = path.dirname(DB_PATH);
const WAL_PATH = DB_PATH + "-wal";
const SHM_PATH = DB_PATH + "-shm";

const WAL_GUARD_BYTES = 50 * 1024 * 1024;   // 50 MB
const WARN_THRESHOLD  = 0.80;                // 80% used → warning
const AUTO_CLEANUP    = 0.95;                // 95% used → emergency prune

// ─── Disk stats ───────────────────────────────────────────────────────────────

export interface DiskStats {
  used_mb:     number;
  free_mb:     number;
  total_mb:    number;
  percent_used: number;
  db_size_mb:  number;
  wal_size_mb: number;
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Read disk usage for the Railway volume using statvfs via /proc or df fallback. */
export function getDiskStats(): DiskStats {
  const db_bytes  = fileSize(DB_PATH);
  const wal_bytes = fileSize(WAL_PATH) + fileSize(SHM_PATH);

  let total_bytes = 0;
  let free_bytes  = 0;

  try {
    // Parse `df -k <dir>` — works reliably in Railway's Linux container
    const { execSync } = require("child_process");
    const out: string = execSync(`df -k "${DATA_DIR}" 2>/dev/null`, { encoding: "utf8", timeout: 3000 });
    const lines = out.trim().split("\n");
    // Header: Filesystem  1K-blocks  Used  Available  Use%  Mounted
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    total_bytes = parseInt(parts[1], 10) * 1024;
    free_bytes  = parseInt(parts[3], 10) * 1024;
  } catch {
    // Fallback: can't read df — use DB file size only as rough indicator
    total_bytes = 0;
    free_bytes  = 0;
  }

  const used_bytes = total_bytes - free_bytes;
  const pct = total_bytes > 0 ? used_bytes / total_bytes : 0;

  return {
    used_mb:      Math.round(used_bytes / 1024 / 1024 * 10) / 10,
    free_mb:      Math.round(free_bytes  / 1024 / 1024 * 10) / 10,
    total_mb:     Math.round(total_bytes / 1024 / 1024 * 10) / 10,
    percent_used: Math.round(pct * 1000) / 10,
    db_size_mb:   Math.round(db_bytes  / 1024 / 1024 * 100) / 100,
    wal_size_mb:  Math.round(wal_bytes / 1024 / 1024 * 100) / 100,
  };
}

// ─── WAL checkpoint ───────────────────────────────────────────────────────────

export function walCheckpoint(): void {
  try {
    sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
    console.log("[DiskMonitor] WAL checkpoint (TRUNCATE) completed");
  } catch (e) {
    console.error("[DiskMonitor] WAL checkpoint failed:", e);
  }
}

/** Guard: checkpoint immediately if WAL file is too large. */
export function walGuard(): void {
  const wal_bytes = fileSize(WAL_PATH);
  if (wal_bytes > WAL_GUARD_BYTES) {
    console.warn(`[DiskMonitor] WAL guard triggered: WAL is ${(wal_bytes / 1024 / 1024).toFixed(1)} MB — checkpointing now`);
    walCheckpoint();
  }
}

// ─── Pruning ──────────────────────────────────────────────────────────────────

export interface PruneResult {
  recommendations_deleted: number;
  refresh_log_deleted:     number;
  backtest_deleted:        number;
  signals_deleted:         number;
  earnings_deleted:        number;
  wal_checkpointed:        boolean;
  stats_before:            DiskStats;
  stats_after:             DiskStats;
  ran_at:                  string;
}

export function runPrune(): PruneResult {
  const ran_at = new Date().toISOString();
  console.log("[DiskMonitor] Starting scheduled prune...");
  const stats_before = getDiskStats();

  // 1. recommendations — keep only 1 row per ticker (latest generated_at)
  //    The UPSERT in saveRecommendation should already maintain this, but
  //    sweep for any stragglers where ON CONFLICT didn't fire.
  let rec_deleted = 0;
  try {
    const r = sqlite.prepare(`
      DELETE FROM recommendations
      WHERE id NOT IN (
        SELECT id FROM recommendations r2
        WHERE r2.ticker = recommendations.ticker
        ORDER BY r2.generated_at DESC
        LIMIT 1
      )
    `).run();
    rec_deleted = r.changes;
  } catch (e) {
    console.error("[DiskMonitor] prune recommendations failed:", e);
  }

  // 2. refresh_log — keep latest 500 rows
  let log_deleted = 0;
  try {
    const r = sqlite.prepare(`
      DELETE FROM refresh_log
      WHERE id NOT IN (
        SELECT id FROM refresh_log ORDER BY id DESC LIMIT 500
      )
    `).run();
    log_deleted = r.changes;
  } catch { /* table may not exist */ }

  // 3. backtest_records — keep latest 10,000 rows
  let backtest_deleted = 0;
  try {
    const r = sqlite.prepare(`
      DELETE FROM backtest_records
      WHERE id NOT IN (
        SELECT id FROM backtest_records ORDER BY id DESC LIMIT 10000
      )
    `).run();
    backtest_deleted = r.changes;
  } catch { /* table may not exist */ }

  // 4. signals (insider data) — delete entries older than 90 days
  let signals_deleted = 0;
  try {
    const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const r = sqlite.prepare(
      "DELETE FROM signals WHERE filed_at < ? OR (filed_at IS NULL AND created_at < ?)"
    ).run(cutoff90, cutoff90);
    signals_deleted = r.changes;
  } catch { /* table may not exist or different schema */ }

  // 5. earnings — delete entries older than 180 days
  let earnings_deleted = 0;
  try {
    const cutoff180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const r = sqlite.prepare(
      "DELETE FROM earnings WHERE earnings_date < ?"
    ).run(cutoff180);
    earnings_deleted = r.changes;
  } catch { /* table may not exist */ }

  // 6. WAL checkpoint — the single biggest disk reclaim step
  let wal_checkpointed = false;
  try {
    walCheckpoint();
    wal_checkpointed = true;
  } catch { /* logged inside walCheckpoint */ }

  const stats_after = getDiskStats();
  const result: PruneResult = {
    recommendations_deleted: rec_deleted,
    refresh_log_deleted:     log_deleted,
    backtest_deleted,
    signals_deleted,
    earnings_deleted,
    wal_checkpointed,
    stats_before,
    stats_after,
    ran_at,
  };

  console.log(
    `[DiskMonitor] Prune complete — removed: ${rec_deleted} recs, ${log_deleted} logs, ` +
    `${backtest_deleted} backtests, ${signals_deleted} signals, ${earnings_deleted} earnings. ` +
    `Disk: ${stats_before.percent_used}% → ${stats_after.percent_used}%`
  );
  return result;
}

// ─── Emergency prune (triggered automatically at ≥95% disk usage) ────────────

export function emergencyPrune(): void {
  console.warn("[DiskMonitor] EMERGENCY: disk at ≥95% — running aggressive prune");
  runPrune();

  // Additional aggressive prune: drop oldest half of backtest_records
  try {
    sqlite.prepare(`
      DELETE FROM backtest_records
      WHERE id NOT IN (
        SELECT id FROM backtest_records ORDER BY id DESC LIMIT 5000
      )
    `).run();
  } catch { /* non-fatal */ }

  // Vacuum to reclaim free pages (can be slow but disk is critical)
  try {
    sqlite.prepare("VACUUM").run();
    console.log("[DiskMonitor] VACUUM complete");
  } catch (e) {
    console.error("[DiskMonitor] VACUUM failed:", e);
  }

  walCheckpoint();
}

// ─── Startup check ────────────────────────────────────────────────────────────

export function startupDiskCheck(): void {
  try {
    const stats = getDiskStats();
    const pct = stats.percent_used;

    if (stats.total_mb > 0) {
      console.log(
        `[DiskMonitor] Startup: volume ${stats.used_mb} MB used / ${stats.total_mb} MB total (${pct}%) — ` +
        `DB ${stats.db_size_mb} MB, WAL ${stats.wal_size_mb} MB, free ${stats.free_mb} MB`
      );
    } else {
      console.log(
        `[DiskMonitor] Startup: DB ${stats.db_size_mb} MB, WAL ${stats.wal_size_mb} MB (volume stats unavailable)`
      );
    }

    if (pct >= AUTO_CLEANUP * 100) {
      console.warn(`[DiskMonitor] Storage CRITICAL: disk usage at ${pct}% — triggering emergency cleanup`);
      emergencyPrune();
    } else if (pct >= WARN_THRESHOLD * 100) {
      console.warn(`[DiskMonitor] Storage WARNING: disk usage at ${pct}% — consider cleanup`);
    }

    // Always run WAL guard on startup
    walGuard();
  } catch (e) {
    console.error("[DiskMonitor] Startup check failed:", e);
  }
}

// ─── Scheduled daily pruning ─────────────────────────────────────────────────
// Called from scheduler.ts startScheduler() so it uses the same cron infra.

let _pruneTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleDailyPrune(): void {
  // Run once at startup after a short delay (let DB settle), then every 24h
  const MS_24H = 24 * 60 * 60 * 1000;
  const INITIAL_DELAY = 60 * 1000; // 1 minute after startup

  const runAndReschedule = () => {
    try {
      walGuard(); // check WAL before prune too
      runPrune();
    } catch (e) {
      console.error("[DiskMonitor] Scheduled prune failed:", e);
    }
    _pruneTimer = setTimeout(runAndReschedule, MS_24H);
  };

  _pruneTimer = setTimeout(runAndReschedule, INITIAL_DELAY);
  console.log("[DiskMonitor] Daily pruning scheduled (first run in ~1 min, then every 24h)");
}

export function stopDailyPrune(): void {
  if (_pruneTimer) { clearTimeout(_pruneTimer); _pruneTimer = null; }
}
