// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for durable AI-detection policy and cost reporting events
// ABOUTME: Covers idempotent ledger writes and admin reporting aggregates

import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildAIOutcomeEvent,
  buildAIPolicyDecisionEvent,
  buildAIReportEvent,
  getAIDetectionStats,
  initAIDetectionEventsTable,
  recordAIDetectionEvent,
} from './ai-detection-events.mjs';

const SHA = 'a'.repeat(64);

describe('AI detection event ledger', () => {
  beforeEach(async () => {
    await initAIDetectionEventsTable(env.BLOSSOM_DB);
    await env.BLOSSOM_DB.prepare('DELETE FROM ai_detection_events').run();
  });

  it('records events idempotently by event_key', async () => {
    const event = {
      eventKey: 'policy:abc:1',
      sha256: SHA,
      eventType: 'policy_decision',
      policyReason: 'valid_proofmode_skip',
      c2paState: 'valid_proofmode',
      aiDetectionRan: false,
      aiDetectionForced: false,
      createdAt: '2026-05-03T00:00:00.000Z',
    };

    await recordAIDetectionEvent(env.BLOSSOM_DB, event);
    await recordAIDetectionEvent(env.BLOSSOM_DB, event);

    const row = await env.BLOSSOM_DB.prepare('SELECT COUNT(*) AS cnt FROM ai_detection_events').first();
    expect(row.cnt).toBe(1);
  });

  it('aggregates runs, skips, forced reports, review outcomes, and estimated savings', async () => {
    await recordAIDetectionEvent(env.BLOSSOM_DB, {
      eventKey: 'policy:skip',
      sha256: 'b'.repeat(64),
      eventType: 'policy_decision',
      policyReason: 'valid_proofmode_skip',
      c2paState: 'valid_proofmode',
      aiDetectionRan: false,
      aiDetectionForced: false,
      createdAt: '2026-05-03T00:10:00.000Z',
    });
    await recordAIDetectionEvent(env.BLOSSOM_DB, {
      eventKey: 'policy:run',
      sha256: 'c'.repeat(64),
      eventType: 'policy_decision',
      policyReason: 'no_proof_ai_detection',
      c2paState: 'absent',
      aiDetectionRan: true,
      aiDetectionForced: false,
      createdAt: '2026-05-03T00:11:00.000Z',
    });
    await recordAIDetectionEvent(env.BLOSSOM_DB, {
      eventKey: 'report:forced',
      sha256: 'd'.repeat(64),
      eventType: 'user_report',
      policyReason: 'report_forced_ai_detection',
      aiDetectionRan: false,
      aiDetectionForced: true,
      reportType: 'ai_generated',
      createdAt: '2026-05-03T00:12:00.000Z',
    });
    await recordAIDetectionEvent(env.BLOSSOM_DB, {
      eventKey: 'outcome:review',
      sha256: 'd'.repeat(64),
      eventType: 'moderation_outcome',
      policyReason: 'proofmode_ai_downgrade',
      c2paState: 'valid_proofmode',
      aiDetectionRan: true,
      aiDetectionForced: true,
      aiScore: 0.97,
      action: 'REVIEW',
      createdAt: '2026-05-03T00:13:00.000Z',
    });

    const stats = await getAIDetectionStats(env.BLOSSOM_DB, {
      window: '24h',
      now: new Date('2026-05-03T01:00:00.000Z'),
      estimatedCostCents: 65,
    });

    expect(stats.totals.aiDetectionRuns).toBe(1);
    expect(stats.totals.aiDetectionSkips).toBe(1);
    expect(stats.totals.proofModeSkips).toBe(1);
    expect(stats.totals.reportForcedChecks).toBe(1);
    expect(stats.totals.openReviewItems).toBe(1);
    expect(stats.estimatedSpendAvoidedCents).toBe(65);
  });

  it('builds compact report, policy, and outcome events', () => {
    const report = buildAIReportEvent({
      sha256: SHA,
      reportType: 'ai_generated',
      createdAt: '2026-05-03T00:00:00.000Z',
    });
    expect(report).toMatchObject({
      eventKey: `report:${SHA}:ai_generated:2026-05-03T00:00:00.000Z`,
      eventType: 'user_report',
      policyReason: 'report_forced_ai_detection',
      aiDetectionForced: true,
      reportType: 'ai_generated',
    });

    const result = {
      action: 'REVIEW',
      scores: { ai_generated: 0.97 },
      c2pa: { state: 'valid_proofmode' },
      aiDetectionPolicy: {
        policyReason: 'report_forced_ai_detection',
        aiDetectionRan: true,
        aiDetectionForced: true,
      },
      policyContext: { overrideReason: 'proofmode-capture-authenticated' },
    };

    const policy = buildAIPolicyDecisionEvent({ sha256: SHA, uploadedAt: 1777770000000, result });
    const outcome = buildAIOutcomeEvent({ sha256: SHA, uploadedAt: 1777770000000, result });

    expect(policy).toMatchObject({
      eventType: 'policy_decision',
      policyReason: 'report_forced_ai_detection',
      aiDetectionForced: true,
    });
    expect(outcome).toMatchObject({
      eventType: 'moderation_outcome',
      policyReason: 'proofmode_ai_downgrade',
      action: 'REVIEW',
      aiScore: 0.97,
    });
  });
});
