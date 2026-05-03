// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Durable ledger and reporting helpers for paid AI-detection policy decisions
// ABOUTME: Powers admin cost and review reporting for ProofMode/report-triggered AI checks

const VALID_WINDOWS = new Map([
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
  ['all', null],
]);

export async function initAIDetectionEventsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ai_detection_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      event_type TEXT NOT NULL,
      policy_reason TEXT,
      c2pa_state TEXT,
      ai_detection_ran INTEGER NOT NULL DEFAULT 0,
      ai_detection_forced INTEGER NOT NULL DEFAULT 0,
      ai_score REAL,
      action TEXT,
      report_type TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_detection_events_created_at ON ai_detection_events(created_at)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_detection_events_sha256 ON ai_detection_events(sha256)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_detection_events_type ON ai_detection_events(event_type)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_detection_events_reason ON ai_detection_events(policy_reason)').run();
}

export async function recordAIDetectionEvent(db, event) {
  if (!db || !event?.eventKey || !event?.sha256 || !event?.eventType) {
    return { recorded: false, reason: 'invalid_event' };
  }

  const metadataJson = event.metadata === undefined
    ? null
    : JSON.stringify(event.metadata);

  await db.prepare(`
    INSERT OR IGNORE INTO ai_detection_events (
      event_key, sha256, event_type, policy_reason, c2pa_state,
      ai_detection_ran, ai_detection_forced, ai_score, action, report_type,
      metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.eventKey,
    event.sha256,
    event.eventType,
    event.policyReason ?? null,
    event.c2paState ?? null,
    event.aiDetectionRan ? 1 : 0,
    event.aiDetectionForced ? 1 : 0,
    typeof event.aiScore === 'number' ? event.aiScore : null,
    event.action ?? null,
    event.reportType ?? null,
    metadataJson,
    event.createdAt ?? new Date().toISOString(),
  ).run();

  return { recorded: true };
}

export function parseAIDetectionStatsWindow(value) {
  return VALID_WINDOWS.has(value) ? value : '24h';
}

export async function getAIDetectionStats(db, options = {}) {
  const window = parseAIDetectionStatsWindow(options.window);
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoffMs = VALID_WINDOWS.get(window);
  const cutoff = cutoffMs === null ? null : new Date(now.getTime() - cutoffMs).toISOString();
  const estimatedCostCents = Number.isFinite(options.estimatedCostCents)
    ? options.estimatedCostCents
    : null;
  const whereClause = cutoff ? 'WHERE created_at >= ?' : '';
  const bindWindow = stmt => cutoff ? stmt.bind(cutoff) : stmt;

  const totalsRow = await bindWindow(db.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'policy_decision' AND ai_detection_ran = 1 THEN 1 ELSE 0 END) AS ai_detection_runs,
      SUM(CASE WHEN event_type = 'policy_decision' AND ai_detection_ran = 0 THEN 1 ELSE 0 END) AS ai_detection_skips,
      SUM(CASE WHEN event_type = 'policy_decision' AND policy_reason = 'valid_proofmode_skip' THEN 1 ELSE 0 END) AS proofmode_skips,
      SUM(CASE WHEN event_type = 'policy_decision' AND policy_reason = 'valid_ai_signed_skip' THEN 1 ELSE 0 END) AS signed_ai_skips,
      SUM(CASE WHEN event_type = 'policy_decision' AND policy_reason = 'original_vine_skip' THEN 1 ELSE 0 END) AS original_vine_skips,
      SUM(CASE WHEN event_type = 'user_report' AND ai_detection_forced = 1 THEN 1 ELSE 0 END) AS report_forced_checks,
      SUM(CASE WHEN event_type = 'moderation_outcome' AND action = 'REVIEW' THEN 1 ELSE 0 END) AS open_review_items
    FROM ai_detection_events
    ${whereClause}
  `)).first();

  const policyRows = await bindWindow(db.prepare(`
    SELECT policy_reason, COUNT(*) AS count
    FROM ai_detection_events
    ${whereClause ? `${whereClause} AND` : 'WHERE'} event_type = 'policy_decision'
    GROUP BY policy_reason
    ORDER BY count DESC
  `)).all();

  const reviewRows = await bindWindow(db.prepare(`
    SELECT policy_reason, COUNT(*) AS count
    FROM ai_detection_events
    ${whereClause ? `${whereClause} AND` : 'WHERE'} event_type = 'moderation_outcome' AND action = 'REVIEW'
    GROUP BY policy_reason
    ORDER BY count DESC
  `)).all();

  const recentReviewRows = await bindWindow(db.prepare(`
    SELECT sha256, action, c2pa_state, ai_score, policy_reason, created_at
    FROM ai_detection_events
    ${whereClause ? `${whereClause} AND` : 'WHERE'} event_type = 'moderation_outcome' AND action = 'REVIEW'
    ORDER BY created_at DESC
    LIMIT 10
  `)).all();

  const totals = {
    aiDetectionRuns: totalsRow?.ai_detection_runs ?? 0,
    aiDetectionSkips: totalsRow?.ai_detection_skips ?? 0,
    proofModeSkips: totalsRow?.proofmode_skips ?? 0,
    signedAISkips: totalsRow?.signed_ai_skips ?? 0,
    originalVineSkips: totalsRow?.original_vine_skips ?? 0,
    reportForcedChecks: totalsRow?.report_forced_checks ?? 0,
    openReviewItems: totalsRow?.open_review_items ?? 0,
  };

  return {
    window,
    since: cutoff,
    totals,
    estimatedSpendAvoidedCents: estimatedCostCents === null
      ? null
      : totals.aiDetectionSkips * estimatedCostCents,
    policyBreakdown: (policyRows.results || []).map(row => ({
      policyReason: row.policy_reason || 'unknown',
      count: row.count || 0,
    })),
    reviewBreakdown: (reviewRows.results || []).map(row => ({
      policyReason: row.policy_reason || 'unknown',
      count: row.count || 0,
    })),
    recentReviewItems: (recentReviewRows.results || []).map(row => ({
      sha256: row.sha256,
      action: row.action,
      c2paState: row.c2pa_state,
      aiScore: row.ai_score,
      policyReason: row.policy_reason,
      createdAt: row.created_at,
    })),
  };
}

export function buildAIReportEvent({ sha256, reportType, createdAt }) {
  return {
    eventKey: `report:${sha256}:${reportType}:${createdAt}`,
    sha256,
    eventType: 'user_report',
    policyReason: 'report_forced_ai_detection',
    aiDetectionRan: false,
    aiDetectionForced: true,
    reportType,
    createdAt,
  };
}

export function buildAIPolicyDecisionEvent({ sha256, uploadedAt, result }) {
  const policy = result?.aiDetectionPolicy || {};
  const forceFlag = policy.aiDetectionForced ? 'forced' : 'default';
  return {
    eventKey: `policy:${sha256}:${uploadedAt ?? 'unknown'}:${forceFlag}`,
    sha256,
    eventType: 'policy_decision',
    policyReason: policy.policyReason || 'unknown',
    c2paState: result?.c2pa?.state || policy.c2paState || null,
    aiDetectionRan: policy.aiDetectionRan === true,
    aiDetectionForced: policy.aiDetectionForced === true,
    createdAt: new Date().toISOString(),
  };
}

export function buildAIOutcomeEvent({ sha256, uploadedAt, result }) {
  const policy = result?.aiDetectionPolicy || {};
  const policyReason = result?.policyContext?.overrideReason === 'proofmode-capture-authenticated'
    ? 'proofmode_ai_downgrade'
    : (policy.policyReason || 'unknown');
  const aiScore = Math.max(
    numericScore(result?.scores?.ai_generated),
    numericScore(result?.scores?.deepfake),
  );

  return {
    eventKey: `outcome:${sha256}:${uploadedAt ?? 'unknown'}:${result?.action || 'unknown'}:${policyReason}`,
    sha256,
    eventType: 'moderation_outcome',
    policyReason,
    c2paState: result?.c2pa?.state || policy.c2paState || null,
    aiDetectionRan: policy.aiDetectionRan === true,
    aiDetectionForced: policy.aiDetectionForced === true,
    aiScore: Number.isFinite(aiScore) ? aiScore : null,
    action: result?.action || null,
    createdAt: new Date().toISOString(),
  };
}

function numericScore(value) {
  return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY;
}
