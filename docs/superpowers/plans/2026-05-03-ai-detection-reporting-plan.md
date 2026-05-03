# AI Detection Reporting Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build durable AI-detection policy reporting and an admin dashboard panel for ProofMode cost savings and AI-report moderation work.

**Architecture:** Add a small D1 ledger module for AI-detection events, then expose aggregated admin stats from that ledger. Existing report and moderation paths write compact events; the existing dashboard reads a new admin endpoint and renders the reporting band.

**Tech Stack:** Cloudflare Worker, D1, Vitest, plain admin HTML/JS, existing moderation pipeline modules.

---

## File Structure

- Create `migrations/006-ai-detection-events.sql`: production D1 table, uniqueness, and indexes.
- Create `src/moderation/ai-detection-events.mjs`: table init, event recording, event builders, stats aggregation.
- Create `src/moderation/ai-detection-events.test.mjs`: focused TDD coverage for idempotent writes and stats.
- Modify `src/index.mjs`: initialize table, write events from report and queue paths, add `/admin/api/ai-detection/stats`.
- Modify `src/index.test.mjs`: route and report-trigger coverage.
- Modify `src/moderation/ai-detection-policy.mjs`: expose a policy reason helper instead of only booleans.
- Modify `src/moderation/ai-detection-policy.test.mjs`: policy reason coverage.
- Modify `src/moderation/pipeline.mjs`: include AI-detection policy metadata in results.
- Modify `src/moderation/pipeline.test.mjs`: verify result metadata for skip, run, and forced cases.
- Modify `src/admin/dashboard.html`: add the AI detection reporting panel and fetch logic.
- Modify `src/admin/dashboard-ui.test.mjs`: static dashboard hook coverage.

## Chunk 1: Ledger Module And Migration

### Task 1: Add the D1 schema

**Files:**
- Create: `migrations/006-ai-detection-events.sql`

- [ ] **Step 1: Write migration**

```sql
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
);

CREATE INDEX IF NOT EXISTS idx_ai_detection_events_created_at ON ai_detection_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_detection_events_sha256 ON ai_detection_events(sha256);
CREATE INDEX IF NOT EXISTS idx_ai_detection_events_type ON ai_detection_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ai_detection_events_reason ON ai_detection_events(policy_reason);
```

- [ ] **Step 2: Do not apply production migration yet**

Production migration should be applied after code tests pass and before deploy:

```bash
npx wrangler d1 migrations apply blossom-webhook-events --remote
```

Expected later: migration `006-ai-detection-events.sql` applies cleanly.

### Task 2: Write failing ledger tests

**Files:**
- Create: `src/moderation/ai-detection-events.test.mjs`
- Create: `src/moderation/ai-detection-events.mjs`

- [ ] **Step 1: Write failing tests**

Test cases:

```js
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  initAIDetectionEventsTable,
  recordAIDetectionEvent,
  getAIDetectionStats,
} from './ai-detection-events.mjs';

describe('AI detection event ledger', () => {
  beforeEach(async () => {
    await initAIDetectionEventsTable(env.BLOSSOM_DB);
    await env.BLOSSOM_DB.prepare('DELETE FROM ai_detection_events').run();
  });

  it('records events idempotently by event_key', async () => {
    const event = {
      eventKey: 'policy:abc:1',
      sha256: 'a'.repeat(64),
      eventType: 'policy_decision',
      policyReason: 'valid_proofmode_skip',
      c2paState: 'valid_proofmode',
      aiDetectionRan: false,
      aiDetectionForced: false,
      createdAt: '2026-05-03T00:00:00.000Z',
    };

    await recordAIDetectionEvent(env.BLOSSOM_DB, event);
    await recordAIDetectionEvent(env.BLOSSOM_DB, event);

    const row = await env.BLOSSOM_DB.prepare(
      'SELECT COUNT(*) AS cnt FROM ai_detection_events'
    ).first();
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
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs
```

Expected: FAIL because `ai-detection-events.mjs` exports do not exist or are not implemented.

### Task 3: Implement the ledger module

**Files:**
- Modify: `src/moderation/ai-detection-events.mjs`

- [ ] **Step 1: Implement minimal module**

Core exports:

```js
export async function initAIDetectionEventsTable(db) { /* CREATE TABLE + indexes */ }
export async function recordAIDetectionEvent(db, event) { /* INSERT OR IGNORE */ }
export function parseAIDetectionStatsWindow(value) { /* 24h, 7d, 30d, all */ }
export async function getAIDetectionStats(db, options = {}) { /* aggregates */ }
```

Implementation notes:

- Store booleans as `0` or `1`.
- Serialize only compact metadata into `metadata_json`.
- Use `INSERT OR IGNORE` on `event_key`.
- Use `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` for D1 compatibility.
- For `window !== 'all'`, bind a cutoff ISO timestamp.

- [ ] **Step 2: Run tests to verify GREEN**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs
```

Expected: PASS.

## Chunk 2: Policy Metadata In Pipeline Results

### Task 4: Extend AI-detection policy helper

**Files:**
- Modify: `src/moderation/ai-detection-policy.mjs`
- Modify: `src/moderation/ai-detection-policy.test.mjs`

- [ ] **Step 1: Write failing policy tests**

Add expectations for a new helper:

```js
import { getAIDetectionPolicyDecision } from './ai-detection-policy.mjs';

expect(getAIDetectionPolicyDecision({
  c2pa: { state: 'valid_proofmode' },
  metadata: {},
  originalVine: false,
})).toMatchObject({
  aiDetectionAllowed: false,
  policyReason: 'valid_proofmode_skip',
});

expect(getAIDetectionPolicyDecision({
  c2pa: { state: 'valid_proofmode' },
  metadata: { forceAIDetection: true },
  originalVine: false,
})).toMatchObject({
  aiDetectionAllowed: true,
  aiDetectionForced: true,
  policyReason: 'report_forced_ai_detection',
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --dir src moderation/ai-detection-policy.test.mjs
```

Expected: FAIL because the new helper is absent.

- [ ] **Step 3: Implement helper**

Return a small object:

```js
{
  aiDetectionAllowed: boolean,
  aiDetectionForced: boolean,
  policyReason: 'valid_proofmode_skip' | 'report_forced_ai_detection' | 'original_vine_skip' | 'no_proof_ai_detection' | 'provenance_present_ai_detection',
}
```

Keep existing `shouldForceAIDetection` and `proofModeSkipsAIDetection` exports for compatibility.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run --dir src moderation/ai-detection-policy.test.mjs
```

Expected: PASS.

### Task 5: Attach policy metadata to moderation results

**Files:**
- Modify: `src/moderation/pipeline.mjs`
- Modify: `src/moderation/pipeline.test.mjs`

- [ ] **Step 1: Write failing pipeline tests**

Extend existing ProofMode/no-proof tests to assert:

```js
expect(result.aiDetectionPolicy).toMatchObject({
  aiDetectionAllowed: false,
  aiDetectionForced: false,
  policyReason: 'valid_proofmode_skip',
});
```

For forced report case:

```js
expect(result.aiDetectionPolicy).toMatchObject({
  aiDetectionAllowed: true,
  aiDetectionForced: true,
  policyReason: 'report_forced_ai_detection',
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --dir src moderation/pipeline.test.mjs -t "C2PA / ProofMode enforcement"
```

Expected: FAIL because `result.aiDetectionPolicy` is absent.

- [ ] **Step 3: Implement result metadata**

In `moderateVideo`, compute the policy decision after C2PA verification and include it in the returned result:

```js
const aiDetectionPolicy = {
  ...getAIDetectionPolicyDecision({ c2pa, metadata, originalVine: originalVineSkipsAIDetection }),
  c2paState: c2pa.state,
};
```

After provider response, include actual result booleans:

```js
aiDetectionPolicy.aiDetectionRan = !!moderationResult.raw?.aiDetection;
aiDetectionPolicy.aiDetectionSkipped = moderationResult.raw?.skippedAIDetection === true;
```

For `valid_ai_signed` short circuit, include:

```js
aiDetectionPolicy: {
  aiDetectionAllowed: false,
  aiDetectionForced: false,
  aiDetectionRan: false,
  aiDetectionSkipped: true,
  policyReason: 'valid_ai_signed_skip',
  c2paState: 'valid_ai_signed',
}
```

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run --dir src moderation/pipeline.test.mjs -t "C2PA / ProofMode enforcement"
```

Expected: PASS.

## Chunk 3: Event Writes From Reports And Moderation

### Task 6: Build event objects

**Files:**
- Modify: `src/moderation/ai-detection-events.mjs`
- Modify: `src/moderation/ai-detection-events.test.mjs`

- [ ] **Step 1: Write failing builder tests**

Add tests for:

```js
buildAIReportEvent({ sha256, reportType, createdAt })
buildAIPolicyDecisionEvent({ sha256, uploadedAt, result })
buildAIOutcomeEvent({ sha256, uploadedAt, result })
```

Expected outputs should include stable `eventKey` and compact fields.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs
```

Expected: FAIL because builders are absent.

- [ ] **Step 3: Implement builders**

Rules:

- Report event key: `report:${sha256}:${reportType}:${createdAt}`
- Policy event key: `policy:${sha256}:${uploadedAt}:${forceFlag}`
- Outcome event key: `outcome:${sha256}:${uploadedAt}:${action}:${policyReason}`
- Outcome `policyReason` becomes `proofmode_ai_downgrade` when `result.policyContext?.overrideReason === 'proofmode-capture-authenticated'`.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs
```

Expected: PASS.

### Task 7: Write events from `/api/v1/report`

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write failing route test**

Extend the existing "queues a forced AI recheck" test to use a DB mock that captures SQL inserts into `ai_detection_events`, then assert one event is written when `report_type` is `ai_generated`.

Expected event:

```js
expect(insertedEvent).toMatchObject({
  event_type: 'user_report',
  policy_reason: 'report_forced_ai_detection',
  ai_detection_forced: 1,
  report_type: 'ai_generated',
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --dir src index.test.mjs -t "queues a forced AI recheck"
```

Expected: FAIL because no ledger event is written.

- [ ] **Step 3: Implement route write**

Import:

```js
import { initAIDetectionEventsTable, recordAIDetectionEvent, buildAIReportEvent } from './moderation/ai-detection-events.mjs';
```

Initialize the table next to `initReportsTable`.

After successful AI report enqueue, call:

```js
await recordAIDetectionEvent(env.BLOSSOM_DB, buildAIReportEvent({
  sha256,
  reportType: report_type,
  createdAt: new Date().toISOString(),
}));
```

If the ledger write fails, log the error but do not fail the user report.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run --dir src index.test.mjs -t "queues a forced AI recheck"
```

Expected: PASS.

### Task 8: Write events from queue moderation results

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/moderation/ai-detection-events.test.mjs`

- [ ] **Step 1: Write failing helper test**

Add a test that builds policy and outcome events from a forced ProofMode `REVIEW` result and verifies:

```js
expect(policy.eventType).toBe('policy_decision');
expect(policy.aiDetectionForced).toBe(true);
expect(outcome.eventType).toBe('moderation_outcome');
expect(outcome.policyReason).toBe('proofmode_ai_downgrade');
expect(outcome.action).toBe('REVIEW');
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs
```

Expected: FAIL until builders support outcome downgrade logic.

- [ ] **Step 3: Implement queue writes**

After the moderation result has been stored in `moderation_results`, record:

```js
await recordAIDetectionEvent(env.BLOSSOM_DB, buildAIPolicyDecisionEvent({
  sha256,
  uploadedAt,
  result,
}));

await recordAIDetectionEvent(env.BLOSSOM_DB, buildAIOutcomeEvent({
  sha256,
  uploadedAt,
  result,
}));
```

Wrap each in a non-fatal try/catch. Moderation must continue even if reporting fails.

- [ ] **Step 4: Run targeted tests**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs moderation/pipeline.test.mjs index.test.mjs -t "AI detection|ProofMode|queues a forced AI recheck"
```

Expected: PASS.

## Chunk 4: Admin Stats Endpoint

### Task 9: Add endpoint tests

**Files:**
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write failing auth test**

```js
const response = await worker.fetch(
  new Request('https://moderation.admin.divine.video/admin/api/ai-detection/stats'),
  createEnv()
);
expect(response.status).toBe(401);
```

- [ ] **Step 2: Write failing success test**

Use a DB mock that returns aggregate rows and assert:

```js
expect(response.status).toBe(200);
await expect(response.json()).resolves.toMatchObject({
  window: '24h',
  totals: {
    aiDetectionRuns: 1,
    proofModeSkips: 1,
    reportForcedChecks: 1,
  },
});
```

- [ ] **Step 3: Run RED**

```bash
npx vitest run --dir src index.test.mjs -t "ai-detection/stats"
```

Expected: FAIL because the route does not exist.

### Task 10: Implement endpoint

**Files:**
- Modify: `src/index.mjs`

- [ ] **Step 1: Add route**

Place near `/admin/api/stats`:

```js
if (url.pathname === '/admin/api/ai-detection/stats') {
  const authError = await requireAuth(request, env);
  if (authError) return authError;

  const stats = await getAIDetectionStats(env.BLOSSOM_DB, {
    window: url.searchParams.get('window') || '24h',
    estimatedCostCents: Number(env.HIVE_AI_DETECTION_ESTIMATED_COST_CENTS || 0) || null,
  });

  return new Response(JSON.stringify(stats), { headers: JSON_HEADERS });
}
```

- [ ] **Step 2: Run GREEN**

```bash
npx vitest run --dir src index.test.mjs -t "ai-detection/stats"
```

Expected: PASS.

## Chunk 5: Dashboard Panel

### Task 11: Add dashboard hook tests

**Files:**
- Modify: `src/admin/dashboard-ui.test.mjs`

- [ ] **Step 1: Write failing static tests**

Assert dashboard contains:

```js
expect(dashboardHTML).toContain('ai-detection-panel');
expect(dashboardHTML).toContain('/admin/api/ai-detection/stats');
expect(dashboardHTML).toContain('loadAIDetectionStats');
expect(dashboardHTML).toContain('AI Detection');
expect(dashboardHTML).toContain('Estimated spend avoided');
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --dir src admin/dashboard-ui.test.mjs
```

Expected: FAIL because panel hooks are absent.

### Task 12: Implement dashboard panel

**Files:**
- Modify: `src/admin/dashboard.html`

- [ ] **Step 1: Add HTML band**

Add near existing stat cards:

```html
<section id="ai-detection-panel" class="ai-detection-panel">
  <div class="section-header">
    <h2>AI Detection</h2>
    <select id="ai-detection-window" onchange="loadAIDetectionStats()">
      <option value="24h">24h</option>
      <option value="7d">7d</option>
      <option value="30d">30d</option>
      <option value="all">All</option>
    </select>
  </div>
  <div class="ai-detection-cards">
    <div class="stat-card"><div class="stat-label">AI runs</div><div id="ai-detection-runs" class="stat-value">-</div></div>
    <div class="stat-card"><div class="stat-label">AI skipped</div><div id="ai-detection-skips" class="stat-value">-</div></div>
    <div class="stat-card"><div class="stat-label">ProofMode skips</div><div id="ai-proofmode-skips" class="stat-value">-</div></div>
    <div class="stat-card"><div class="stat-label">Report-forced</div><div id="ai-report-forced" class="stat-value">-</div></div>
    <div class="stat-card"><div class="stat-label">Estimated spend avoided</div><div id="ai-spend-avoided" class="stat-value">-</div></div>
  </div>
  <div id="ai-detection-breakdown"></div>
  <div id="ai-detection-review-slice"></div>
</section>
```

- [ ] **Step 2: Add JS fetch/render function**

```js
async function loadAIDetectionStats() {
  const windowValue = document.getElementById('ai-detection-window')?.value || '24h';
  const response = await fetch('/admin/api/ai-detection/stats?window=' + encodeURIComponent(windowValue));
  if (!response.ok) throw new Error('AI detection stats failed');
  const stats = await response.json();
  document.getElementById('ai-detection-runs').textContent = (stats.totals?.aiDetectionRuns || 0).toLocaleString();
  document.getElementById('ai-detection-skips').textContent = (stats.totals?.aiDetectionSkips || 0).toLocaleString();
  document.getElementById('ai-proofmode-skips').textContent = (stats.totals?.proofModeSkips || 0).toLocaleString();
  document.getElementById('ai-report-forced').textContent = (stats.totals?.reportForcedChecks || 0).toLocaleString();
  document.getElementById('ai-spend-avoided').textContent = formatEstimatedSpend(stats.estimatedSpendAvoidedCents);
}
```

Call `loadAIDetectionStats()` from the same startup path as `loadRealStats()`.

- [ ] **Step 3: Run GREEN**

```bash
npx vitest run --dir src admin/dashboard-ui.test.mjs
```

Expected: PASS.

## Chunk 6: Verification, Migration, Deploy

### Task 13: Run focused verification

- [ ] **Step 1: Run focused tests**

```bash
npx vitest run --dir src moderation/ai-detection-events.test.mjs moderation/ai-detection-policy.test.mjs moderation/pipeline.test.mjs index.test.mjs admin/dashboard-ui.test.mjs
```

Expected: all selected files pass.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: lint passes.

- [ ] **Step 3: Run full source suite**

```bash
npx vitest run --dir src
```

Expected: all source tests pass.

### Task 14: Apply D1 migration

- [ ] **Step 1: Apply remote migration**

```bash
npx wrangler d1 migrations apply blossom-webhook-events --remote
```

Expected: migration `006-ai-detection-events.sql` applies successfully.

- [ ] **Step 2: Verify table exists**

```bash
npx wrangler d1 execute blossom-webhook-events --remote --command "SELECT COUNT(*) AS cnt FROM ai_detection_events"
```

Expected: returns one row with `cnt`.

### Task 15: Deploy and smoke test

- [ ] **Step 1: Deploy**

```bash
npm run deploy
```

Expected: Wrangler reports a new version ID and routes for both production hostnames.

- [ ] **Step 2: Smoke test public API**

```bash
curl -sS -i --max-time 10 https://moderation-api.divine.video/ | sed -n '1,20p'
```

Expected: HTTP 200.

- [ ] **Step 3: Smoke test admin endpoint with Zero Trust context if available**

Use browser or authenticated request to:

```text
https://moderation.admin.divine.video/admin/api/ai-detection/stats?window=24h
```

Expected: JSON response for authenticated admin, 401/Access challenge for unauthenticated request.

### Task 16: Commit implementation

- [ ] **Step 1: Check status**

```bash
git status --short
```

Expected: only intended files changed, plus pre-existing unrelated untracked files remain untouched.

- [ ] **Step 2: Commit intended implementation files only**

```bash
git add migrations/006-ai-detection-events.sql src/moderation/ai-detection-events.mjs src/moderation/ai-detection-events.test.mjs src/moderation/ai-detection-policy.mjs src/moderation/ai-detection-policy.test.mjs src/moderation/pipeline.mjs src/moderation/pipeline.test.mjs src/index.mjs src/index.test.mjs src/admin/dashboard.html src/admin/dashboard-ui.test.mjs docs/superpowers/plans/2026-05-03-ai-detection-reporting-plan.md
git commit -m "feat: add ai detection reporting dashboard"
```

Expected: commit succeeds without staging unrelated files.
