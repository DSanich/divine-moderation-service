// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Repeat offender tracking — per-pubkey moderation stats and risk levels

/**
 * Create the uploader_stats table if it doesn't exist.
 * Safe to call on every request (CREATE TABLE IF NOT EXISTS is idempotent).
 * @param {D1Database} db
 */
export async function initOffenderTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS uploader_stats (
      pubkey TEXT PRIMARY KEY,
      total_scanned INTEGER DEFAULT 0,
      flagged_count INTEGER DEFAULT 0,
      banned_count INTEGER DEFAULT 0,
      restricted_count INTEGER DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      last_flagged_at TEXT,
      risk_level TEXT DEFAULT 'normal'
    )
  `).run();
}

/**
 * UPSERT uploader stats after a moderation result.
 * Increments total_scanned always; increments the relevant counter and
 * updates last_flagged_at for REVIEW / AGE_RESTRICTED / PERMANENT_BAN.
 * Recomputes risk_level after each update.
 *
 * @param {D1Database} db
 * @param {string} pubkey
 * @param {string} action  — SAFE | REVIEW | AGE_RESTRICTED | PERMANENT_BAN
 * @returns {Promise<Object>} updated stats row
 */
export async function updateUploaderStats(db, pubkey, action) {
  const now = new Date().toISOString();
  const isFlagged = ['REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(action);

  // Upsert — insert a baseline row if pubkey is new, then increment
  await db.prepare(`
    INSERT INTO uploader_stats (pubkey, total_scanned, flagged_count, banned_count, restricted_count, review_count, last_flagged_at, risk_level)
    VALUES (?, 1,
      CASE WHEN ? THEN 1 ELSE 0 END,
      CASE WHEN ? = 'PERMANENT_BAN' THEN 1 ELSE 0 END,
      CASE WHEN ? = 'AGE_RESTRICTED' THEN 1 ELSE 0 END,
      CASE WHEN ? = 'REVIEW' THEN 1 ELSE 0 END,
      CASE WHEN ? THEN ? ELSE NULL END,
      'normal')
    ON CONFLICT(pubkey) DO UPDATE SET
      total_scanned = total_scanned + 1,
      flagged_count = flagged_count + CASE WHEN ? THEN 1 ELSE 0 END,
      banned_count = banned_count + CASE WHEN ? = 'PERMANENT_BAN' THEN 1 ELSE 0 END,
      restricted_count = restricted_count + CASE WHEN ? = 'AGE_RESTRICTED' THEN 1 ELSE 0 END,
      review_count = review_count + CASE WHEN ? = 'REVIEW' THEN 1 ELSE 0 END,
      last_flagged_at = CASE WHEN ? THEN ? ELSE last_flagged_at END
  `).bind(
    pubkey,
    isFlagged ? 1 : 0, action, action, action, isFlagged ? 1 : 0, now,
    isFlagged ? 1 : 0, action, action, action, isFlagged ? 1 : 0, now
  ).run();

  // Read updated row to compute risk_level
  const row = await db.prepare(
    'SELECT * FROM uploader_stats WHERE pubkey = ?'
  ).bind(pubkey).first();

  let riskLevel = 'normal';
  if (row.banned_count > 0 || row.restricted_count >= 5) {
    riskLevel = 'high';
  } else if (row.restricted_count >= 3) {
    riskLevel = 'elevated';
  }

  if (riskLevel !== row.risk_level) {
    await db.prepare(
      'UPDATE uploader_stats SET risk_level = ? WHERE pubkey = ?'
    ).bind(riskLevel, pubkey).run();
    row.risk_level = riskLevel;
  }

  return row;
}

/**
 * Return the risk_level for a pubkey, or 'normal' if not found.
 * @param {D1Database} db
 * @param {string} pubkey
 * @returns {Promise<string>}
 */
export async function getUploaderRiskLevel(db, pubkey) {
  const row = await db.prepare(
    'SELECT risk_level FROM uploader_stats WHERE pubkey = ?'
  ).bind(pubkey).first();
  return row?.risk_level ?? 'normal';
}

/**
 * Return the full stats row for a pubkey, or null if not found.
 * @param {D1Database} db
 * @param {string} pubkey
 * @returns {Promise<Object|null>}
 */
export async function getUploaderStats(db, pubkey) {
  return db.prepare(
    'SELECT * FROM uploader_stats WHERE pubkey = ?'
  ).bind(pubkey).first();
}
