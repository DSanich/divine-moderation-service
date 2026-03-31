# Classic Vine Enforcement Rollback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore public serving for classic/original Vine videos that are currently hidden behind stale moderation enforcement, without re-running paid moderation.

**Architecture:** Add a dedicated authenticated admin rollback path that accepts archive candidates, confirms classic-Vine evidence from existing metadata, rewrites enforcement state to `SAFE`, clears stale KV enforcement keys, and re-notifies Blossom. Keep this flow separate from the normal moderation queue so it never calls Hive, Sightengine, or `moderateVideo()`.

**Tech Stack:** Cloudflare Workers, Vitest, D1, KV, Nostr relay metadata lookup, Blossom webhook integration, ESM modules

---

## File Map

- Create: `src/moderation/classic-vine-rollback.mjs`
  Responsible for candidate confirmation, per-SHA rollback execution, and chunk result formatting.
- Create: `src/moderation/classic-vine-rollback.test.mjs`
  Responsible for unit tests covering classic-Vine confirmation and rollback semantics.
- Modify: `src/index.mjs`
  Responsible for wiring the authenticated admin rollback endpoint and delegating to the helper module.
- Modify: `src/index.test.mjs`
  Responsible for integration-style tests covering preview, execute, resume, Blossom notification, and “no paid moderation” guarantees.
- Reference: `docs/superpowers/specs/2026-03-31-classic-vine-enforcement-rollback-design.md`
  Source-of-truth design for incident policy and boundaries.

## Chunk 1: Rollback Helper Module

### Task 1: Write failing unit tests for classic-Vine candidate confirmation

**Files:**
- Create: `src/moderation/classic-vine-rollback.test.mjs`
- Test: `src/moderation/classic-vine-rollback.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, expect, it } from 'vitest';
import { isClassicVineRollbackCandidate } from './classic-vine-rollback.mjs';

describe('isClassicVineRollbackCandidate', () => {
  it('accepts explicit Vine platform metadata', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'sha-list',
      nostrContext: { platform: 'vine' }
    })).toBe(true);
  });

  it('accepts vine.co source URLs', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'sha-list',
      nostrContext: { sourceUrl: 'https://vine.co/v/abc123' }
    })).toBe(true);
  });

  it('accepts published_at fallback only for archive-oriented sources', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'archive-export',
      nostrContext: { publishedAt: 1389756506 }
    })).toBe(true);
  });

  it('rejects weak timestamp-only matches for generic sources', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'd1-query',
      nostrContext: { publishedAt: 1389756506 }
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/moderation/classic-vine-rollback.test.mjs`
Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
const ARCHIVE_SOURCES = new Set(['archive-export', 'sha-list', 'incident-backfill']);

export function isClassicVineRollbackCandidate({ source, nostrContext }) {
  if (!nostrContext) return false;
  if (nostrContext.platform === 'vine') return true;
  if (nostrContext.sourceUrl?.includes('vine.co')) return true;
  if (nostrContext.vineHashId) return true;
  if (nostrContext.client && /vine-(archive-importer|archaeologist)/.test(nostrContext.client)) return true;
  return ARCHIVE_SOURCES.has(source) && Number(nostrContext.publishedAt) < 1514764800;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/moderation/classic-vine-rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/moderation/classic-vine-rollback.mjs src/moderation/classic-vine-rollback.test.mjs
git commit -m "test: add classic vine rollback candidate matcher"
```

### Task 2: Add failing unit tests for enforcement rewrite semantics

**Files:**
- Modify: `src/moderation/classic-vine-rollback.test.mjs`
- Modify: `src/moderation/classic-vine-rollback.mjs`
- Test: `src/moderation/classic-vine-rollback.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
it('preserves stored scores and categories while forcing SAFE enforcement', async () => {
  const row = {
    sha256: 'a'.repeat(64),
    action: 'PERMANENT_BAN',
    provider: 'hive',
    scores: JSON.stringify({ ai_generated: 0.97 }),
    categories: JSON.stringify(['ai_generated']),
    moderated_at: '2026-03-01T00:00:00.000Z'
  };

  const result = buildClassicVineRollbackUpdate(row, '2026-03-31T00:00:00.000Z');
  expect(result.action).toBe('SAFE');
  expect(result.scores).toBe(row.scores);
  expect(result.categories).toBe(row.categories);
  expect(result.reviewed_by).toBe('classic-vine-rollback');
});

it('returns the full KV key list to clear on every execute pass', () => {
  expect(getClassicVineRollbackKvKeys('a'.repeat(64))).toEqual([
    `review:${'a'.repeat(64)}`,
    `quarantine:${'a'.repeat(64)}`,
    `age-restricted:${'a'.repeat(64)}`,
    `permanent-ban:${'a'.repeat(64)}`
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/moderation/classic-vine-rollback.test.mjs`
Expected: FAIL because rewrite helpers do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
export function buildClassicVineRollbackUpdate(row, reviewedAt) {
  return {
    ...row,
    action: 'SAFE',
    review_notes: 'incident rollback: classic vine restore',
    reviewed_by: 'classic-vine-rollback',
    reviewed_at: reviewedAt
  };
}

export function getClassicVineRollbackKvKeys(sha256) {
  return [
    `review:${sha256}`,
    `quarantine:${sha256}`,
    `age-restricted:${sha256}`,
    `permanent-ban:${sha256}`
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/moderation/classic-vine-rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/moderation/classic-vine-rollback.mjs src/moderation/classic-vine-rollback.test.mjs
git commit -m "feat: add classic vine rollback enforcement helpers"
```

## Chunk 2: Admin Endpoint Integration

### Task 3: Add a failing integration test for rollback preview mode

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/index.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('previews classic vine rollback candidates without mutating enforcement state', async () => {
  const response = await worker.fetch(new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Jwt-Assertion': 'test-access-jwt'
    },
    body: JSON.stringify({
      mode: 'preview',
      source: 'sha-list',
      sha256s: ['a'.repeat(64)]
    })
  }), env);

  const json = await response.json();
  expect(response.status).toBe(200);
  expect(json.mode).toBe('preview');
  expect(json.restored).toBe(0);
  expect(json.candidates[0].would_restore).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs`
Expected: FAIL because the admin endpoint does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
if (url.pathname === '/admin/api/classic-vines/rollback' && request.method === 'POST') {
  const authError = await requireAuth(request, env);
  if (authError) return authError;

  const body = await request.json();
  const result = await handleClassicVineRollback(body, env, { mode: 'preview' });
  return jsonResponse(200, result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs`
Expected: PASS for the new preview test.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs src/moderation/classic-vine-rollback.mjs
git commit -m "feat: add classic vine rollback preview endpoint"
```

### Task 4: Add a failing integration test for execute mode

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/moderation/classic-vine-rollback.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('restores enforcement for confirmed classic vines without calling moderation providers', async () => {
  const blossomPayloads = [];
  const providerRequests = [];

  const env = createIntegrationEnv({
    fetch(url, init) {
      if (String(url).includes('mock-blossom')) {
        blossomPayloads.push(JSON.parse(init.body));
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }
      providerRequests.push(String(url));
      return Promise.resolve(new Response('{}', { status: 404 }));
    }
  });

  const response = await worker.fetch(new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Jwt-Assertion': 'test-access-jwt'
    },
    body: JSON.stringify({
      mode: 'execute',
      source: 'sha-list',
      sha256s: ['a'.repeat(64)]
    })
  }), env);

  const json = await response.json();
  expect(response.status).toBe(200);
  expect(json.restored).toBe(1);
  expect(blossomPayloads[0].action).toBe('SAFE');
  expect(providerRequests).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs`
Expected: FAIL because execute mode does not yet rewrite D1/KV state or isolate provider traffic.

- [ ] **Step 3: Write minimal implementation**

```js
export async function executeClassicVineRollback(candidate, env, now = new Date().toISOString()) {
  const row = await env.BLOSSOM_DB.prepare(
    'SELECT sha256, action, provider, scores, categories, moderated_at FROM moderation_results WHERE sha256 = ?'
  ).bind(candidate.sha256).first();

  const update = buildClassicVineRollbackUpdate(row, now);
  await env.BLOSSOM_DB.prepare(`
    INSERT INTO moderation_results (sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, review_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET
      action = excluded.action,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      review_notes = excluded.review_notes
  `).bind(/* ... */).run();

  await Promise.all(getClassicVineRollbackKvKeys(candidate.sha256).map((key) => env.MODERATION_KV.delete(key)));
  await notifyBlossom(candidate.sha256, 'SAFE', env);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs`
Expected: PASS for the execute-mode test.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs src/moderation/classic-vine-rollback.mjs src/moderation/classic-vine-rollback.test.mjs
git commit -m "fix: restore classic vine serving via admin rollback"
```

### Task 5: Add a failing integration test for chunking and resume behavior

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/moderation/classic-vine-rollback.mjs`
- Modify: `src/index.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('returns a cursor for unfinished classic vine rollback batches', async () => {
  const response = await worker.fetch(new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Jwt-Assertion': 'test-access-jwt'
    },
    body: JSON.stringify({
      mode: 'execute',
      source: 'sha-list',
      sha256s: ['a'.repeat(64), 'b'.repeat(64)],
      limit: 1
    })
  }), env);

  const json = await response.json();
  expect(json.next_cursor).toBe('1');
  expect(json.processed).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs`
Expected: FAIL because batching and cursor handling do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
function sliceRollbackCandidates(sha256s, cursor = 0, limit = 500) {
  const start = Number(cursor) || 0;
  const end = Math.min(start + limit, sha256s.length);
  return {
    batch: sha256s.slice(start, end),
    nextCursor: end < sha256s.length ? String(end) : null
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs src/moderation/classic-vine-rollback.mjs
git commit -m "feat: add resumable classic vine rollback batches"
```

## Chunk 3: Verification and Operator Readiness

### Task 6: Run focused tests for the rollback path

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`
- Modify: `src/moderation/classic-vine-rollback.mjs`
- Modify: `src/moderation/classic-vine-rollback.test.mjs`

- [ ] **Step 1: Run unit and integration tests**

Run: `npx vitest run src/moderation/classic-vine-rollback.test.mjs src/index.test.mjs`
Expected: PASS

- [ ] **Step 2: Review the diff for policy boundaries**

Run: `git diff -- src/index.mjs src/index.test.mjs src/moderation/classic-vine-rollback.mjs src/moderation/classic-vine-rollback.test.mjs`
Expected: No calls to `moderateVideo()`, `moderateWithFallback()`, Hive, or Sightengine from the rollback path.

- [ ] **Step 3: Commit**

```bash
git add src/index.mjs src/index.test.mjs src/moderation/classic-vine-rollback.mjs src/moderation/classic-vine-rollback.test.mjs
git commit -m "test: verify classic vine rollback path"
```

### Task 7: Run full verification and document operator commands

**Files:**
- Modify: `docs/superpowers/plans/2026-03-31-classic-vine-enforcement-rollback-plan.md`

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 2: Dry-run a preview payload locally**

Run:

```bash
curl -X POST https://moderation.admin.divine.video/admin/api/classic-vines/rollback \
  -H 'Content-Type: application/json' \
  -H 'CF-Access-Jwt-Assertion: <admin-token>' \
  -d '{
    "mode": "preview",
    "source": "sha-list",
    "sha256s": ["02d82ca751b790794894eaf0767e909355c3a81dae7fe5b6c507321307f22d9b"],
    "limit": 100
  }'
```

Expected: JSON response with `mode=preview`, `restored=0`, and candidate metadata indicating the Vine would be restored.

- [ ] **Step 3: Dry-run an execute payload on a known-bad Vine**

Run:

```bash
curl -X POST https://moderation.admin.divine.video/admin/api/classic-vines/rollback \
  -H 'Content-Type: application/json' \
  -H 'CF-Access-Jwt-Assertion: <admin-token>' \
  -d '{
    "mode": "execute",
    "source": "sha-list",
    "sha256s": ["02d82ca751b790794894eaf0767e909355c3a81dae7fe5b6c507321307f22d9b"],
    "limit": 1
  }'
```

Expected: JSON response with `restored=1`, `failed=0`, and Blossom notified with `SAFE`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-03-31-classic-vine-enforcement-rollback-plan.md
git commit -m "docs: finalize classic vine rollback execution plan"
```

Plan complete and saved to `docs/superpowers/plans/2026-03-31-classic-vine-enforcement-rollback-plan.md`. Ready to execute?
