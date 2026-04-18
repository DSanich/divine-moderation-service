# Creator-delete validation-window physical-delete sweep — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an operator-run script that destroys GCS bytes for creator-deletes that completed during the validation window (when `ENABLE_PHYSICAL_DELETE=false` on Blossom), and tracks per-row completion in D1 so re-runs are O(unfinished).

**Architecture:** Single-file Node ESM script in `scripts/sweep-creator-deletes.mjs`. Reads candidates from D1 via `wrangler d1 execute` shell-out (using `node:child_process`'s `spawnSync` with an args array — never the shell-interpreting `exec`), calls Blossom's `/admin/moderate` via the existing `notifyBlossom()` client from `src/blossom-client.mjs`, and stamps `physical_deleted_at` on success via batched `UPDATE`. All side-effecting collaborators (wrangler shell-out, Blossom client) are dependency-injected so vitest can drive `main()` end-to-end with fakes.

**Tech Stack:** Node 20+, vitest (Workers pool — `nodejs_compat` flag is on so `node:child_process` works), `wrangler` CLI, existing `src/blossom-client.mjs` for Blossom notifications.

**Spec:** `docs/superpowers/specs/2026-04-17-creator-delete-validation-sweep-design.md`
**Issue:** [divine-blossom#90](https://github.com/divinevideo/divine-blossom/issues/90)
**Branch:** `spec/creator-delete-validation-sweep` (already created off `main`)

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `migrations/007-creator-deletions-physical-deleted-at.sql` | new | Adds `physical_deleted_at TEXT` to `creator_deletions`. |
| `scripts/sweep-creator-deletes.mjs` | new | Sweep orchestrator. Single file: CLI parsing, SQL builders, concurrency, Blossom wrapper, main(). |
| `scripts/sweep-creator-deletes.test.mjs` | new | Vitest unit + integration tests. Injects fake shell runner and fake Blossom notifier into the script's exported helpers and `main()`. |

The script keeps every impure operation behind an injectable function so tests do not shell out, do not hit the network, and do not require real D1 / Blossom.

---

## Task 1: D1 migration

**Files:**
- Create: `migrations/007-creator-deletions-physical-deleted-at.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Stamped by scripts/sweep-creator-deletes.mjs only.
-- The live creator-delete pipeline (process.mjs) does not write this column;
-- newly-produced success rows show NULL here until the next sweep run picks
-- them up, calls Blossom (idempotent if bytes already gone), and stamps.
-- Semantic: "the validation sweep confirmed bytes were destroyed for this row."

ALTER TABLE creator_deletions
  ADD COLUMN IF NOT EXISTS physical_deleted_at TEXT;
```

- [ ] **Step 2: Verify SQL parses**

Run: `sqlite3 :memory: ".read migrations/006-creator-deletions.sql" ".read migrations/007-creator-deletions-physical-deleted-at.sql" ".schema creator_deletions"`

Expected: schema dump includes the new column line `physical_deleted_at TEXT`. (D1 uses SQLite's grammar; if `sqlite3` is missing locally, the wrangler `--local` apply in Task 12 will catch syntax errors too.)

- [ ] **Step 3: Commit**

```bash
git add migrations/007-creator-deletions-physical-deleted-at.sql
git commit -m "feat(migration): add physical_deleted_at to creator_deletions (007)"
```

---

## Task 2: Script scaffolding + parseArgs

**Files:**
- Create: `scripts/sweep-creator-deletes.mjs`
- Create: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sweep-creator-deletes.test.mjs`:

```js
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for scripts/sweep-creator-deletes.mjs — pure helpers + main() with injected deps.
// ABOUTME: Vitest runs under @cloudflare/vitest-pool-workers; nodejs_compat is on so node:child_process imports resolve.

import { describe, it, expect } from 'vitest';
import { parseArgs } from './sweep-creator-deletes.mjs';

describe('parseArgs', () => {
  it('returns defaults when no flags given', () => {
    const cfg = parseArgs([]);
    expect(cfg).toEqual({
      dryRun: false,
      since: null,
      until: null,
      concurrency: 5,
      limit: null,
      blossomWebhookUrl: 'https://media.divine.video/admin/moderate',
      d1Database: 'divine-moderation-decisions-prod'
    });
  });

  it('parses --dry-run as boolean', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --since and --until as ISO strings via Date round-trip', () => {
    const cfg = parseArgs(['--since=2026-04-01T00:00:00.000Z', '--until=2026-04-17T00:00:00.000Z']);
    expect(cfg.since).toBe('2026-04-01T00:00:00.000Z');
    expect(cfg.until).toBe('2026-04-17T00:00:00.000Z');
  });

  it('rejects an unparseable --since', () => {
    expect(() => parseArgs(['--since=not-a-date'])).toThrow(/since/i);
  });

  it('parses --concurrency as positive integer', () => {
    expect(parseArgs(['--concurrency=10']).concurrency).toBe(10);
  });

  it('rejects --concurrency=0', () => {
    expect(() => parseArgs(['--concurrency=0'])).toThrow(/concurrency/i);
  });

  it('rejects --concurrency=-1', () => {
    expect(() => parseArgs(['--concurrency=-1'])).toThrow(/concurrency/i);
  });

  it('parses --limit as non-negative integer', () => {
    expect(parseArgs(['--limit=100']).limit).toBe(100);
  });

  it('rejects --limit=foo', () => {
    expect(() => parseArgs(['--limit=foo'])).toThrow(/limit/i);
  });

  it('parses --blossom-webhook-url and --d1-database overrides', () => {
    const cfg = parseArgs(['--blossom-webhook-url=http://localhost:7676/admin/moderate', '--d1-database=test-db']);
    expect(cfg.blossomWebhookUrl).toBe('http://localhost:7676/admin/moderate');
    expect(cfg.d1Database).toBe('test-db');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL with import error — `scripts/sweep-creator-deletes.mjs` does not exist or does not export `parseArgs`.

- [ ] **Step 3: Implement parseArgs**

Create `scripts/sweep-creator-deletes.mjs`:

```js
#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Validation-window physical-delete sweep for creator-deleted blobs (blossom#90).
// ABOUTME: Reads creator_deletions from D1, asks Blossom to destroy bytes, stamps physical_deleted_at.

const DEFAULT_BLOSSOM_WEBHOOK_URL = 'https://media.divine.video/admin/moderate';
const DEFAULT_D1_DATABASE = 'divine-moderation-decisions-prod';
const DEFAULT_CONCURRENCY = 5;
const FLUSH_BATCH_SIZE = 100;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function getFlag(argv, name) {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

function validateIso(value, fieldName) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be ISO 8601)`);
  }
  return d.toISOString();
}

function validatePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be positive integer)`);
  }
  return n;
}

function validateNonNegativeInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be non-negative integer)`);
  }
  return n;
}

export function parseArgs(argv) {
  const dryRun = getFlag(argv, 'dry-run') === true;
  const since = validateIso(getFlag(argv, 'since') || null, 'since');
  const until = validateIso(getFlag(argv, 'until') || null, 'until');

  const rawConcurrency = getFlag(argv, 'concurrency');
  const concurrency = rawConcurrency
    ? validatePositiveInt(rawConcurrency, 'concurrency')
    : DEFAULT_CONCURRENCY;

  const rawLimit = getFlag(argv, 'limit');
  const limit = rawLimit ? validateNonNegativeInt(rawLimit, 'limit') : null;

  const blossomWebhookUrl = getFlag(argv, 'blossom-webhook-url') || DEFAULT_BLOSSOM_WEBHOOK_URL;
  const d1Database = getFlag(argv, 'd1-database') || DEFAULT_D1_DATABASE;

  return { dryRun, since, until, concurrency, limit, blossomWebhookUrl, d1Database };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — all parseArgs tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): scaffold sweep-creator-deletes script with parseArgs"
```

---

## Task 3: SQL builders + sha256 validation

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import {
  buildSelectCandidatesSql,
  buildSelectUnprocessableSql,
  buildSelectPermanentFailuresSql,
  buildUpdateStampSql,
  validateSha256
} from './sweep-creator-deletes.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('validateSha256', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(validateSha256(SHA_A)).toBe(SHA_A);
  });
  it('rejects uppercase', () => {
    expect(() => validateSha256(SHA_A.toUpperCase())).toThrow(/sha256/i);
  });
  it('rejects shorter than 64', () => {
    expect(() => validateSha256('a'.repeat(63))).toThrow(/sha256/i);
  });
  it('rejects non-hex characters', () => {
    expect(() => validateSha256('z'.repeat(64))).toThrow(/sha256/i);
  });
  it('rejects null/undefined', () => {
    expect(() => validateSha256(null)).toThrow(/sha256/i);
    expect(() => validateSha256(undefined)).toThrow(/sha256/i);
  });
});

describe('buildSelectCandidatesSql', () => {
  it('builds the base select with no optional filters', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: null, limit: null });
    expect(sql).toContain("WHERE status = 'success'");
    expect(sql).toContain('AND physical_deleted_at IS NULL');
    expect(sql).toContain('AND blob_sha256 IS NOT NULL');
    expect(sql).not.toContain('completed_at >=');
    expect(sql).not.toContain('completed_at <');
    expect(sql).not.toContain('LIMIT');
  });

  it('includes since when provided', () => {
    const sql = buildSelectCandidatesSql({ since: '2026-04-01T00:00:00.000Z', until: null, limit: null });
    expect(sql).toContain("AND completed_at >= '2026-04-01T00:00:00.000Z'");
  });

  it('includes until when provided', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: '2026-04-17T00:00:00.000Z', limit: null });
    expect(sql).toContain("AND completed_at < '2026-04-17T00:00:00.000Z'");
  });

  it('includes LIMIT when provided', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: null, limit: 50 });
    expect(sql).toMatch(/LIMIT 50\b/);
  });
});

describe('buildSelectUnprocessableSql', () => {
  it('builds select for status=success rows with NULL sha', () => {
    const sql = buildSelectUnprocessableSql();
    expect(sql).toContain("WHERE status = 'success'");
    expect(sql).toContain('AND blob_sha256 IS NULL');
  });
});

describe('buildSelectPermanentFailuresSql', () => {
  it('builds select for status LIKE failed:permanent:*', () => {
    const sql = buildSelectPermanentFailuresSql();
    expect(sql).toContain("WHERE status LIKE 'failed:permanent:%'");
  });
});

describe('buildUpdateStampSql', () => {
  it('builds an UPDATE with IN-list and NULL guard', () => {
    const sql = buildUpdateStampSql([SHA_A, SHA_B], '2026-04-17T20:00:00.000Z');
    expect(sql).toContain("SET physical_deleted_at = '2026-04-17T20:00:00.000Z'");
    expect(sql).toContain(`WHERE blob_sha256 IN ('${SHA_A}', '${SHA_B}')`);
    expect(sql).toContain('AND physical_deleted_at IS NULL');
  });

  it('rejects an empty sha list (caller bug)', () => {
    expect(() => buildUpdateStampSql([], '2026-04-17T20:00:00.000Z')).toThrow(/empty/i);
  });

  it('rejects when any sha fails validation', () => {
    expect(() => buildUpdateStampSql([SHA_A, 'not-hex'], '2026-04-17T20:00:00.000Z')).toThrow(/sha256/i);
  });

  it('rejects an invalid timestamp', () => {
    expect(() => buildUpdateStampSql([SHA_A], 'not-iso')).toThrow(/timestamp/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — none of the new exports exist.

- [ ] **Step 3: Implement the SQL builders**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
export function validateSha256(s) {
  if (typeof s !== 'string' || !SHA256_HEX.test(s)) {
    throw new Error(`Invalid sha256: ${s}`);
  }
  return s;
}

function validateIsoTimestamp(s) {
  if (typeof s !== 'string') throw new Error(`Invalid timestamp: ${s}`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== s) {
    throw new Error(`Invalid timestamp: ${s}`);
  }
  return s;
}

export function buildSelectCandidatesSql({ since, until, limit }) {
  let sql =
    "SELECT kind5_id, target_event_id, blob_sha256, completed_at FROM creator_deletions" +
    " WHERE status = 'success'" +
    " AND physical_deleted_at IS NULL" +
    " AND blob_sha256 IS NOT NULL";
  if (since) sql += ` AND completed_at >= '${validateIsoTimestamp(since)}'`;
  if (until) sql += ` AND completed_at < '${validateIsoTimestamp(until)}'`;
  if (limit != null) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid limit: ${limit}`);
    sql += ` LIMIT ${limit}`;
  }
  sql += ';';
  return sql;
}

export function buildSelectUnprocessableSql() {
  return (
    "SELECT kind5_id, target_event_id, creator_pubkey, completed_at FROM creator_deletions" +
    " WHERE status = 'success'" +
    " AND blob_sha256 IS NULL;"
  );
}

export function buildSelectPermanentFailuresSql() {
  return (
    "SELECT kind5_id, target_event_id, creator_pubkey, status, last_error FROM creator_deletions" +
    " WHERE status LIKE 'failed:permanent:%';"
  );
}

export function buildUpdateStampSql(shas, timestamp) {
  if (!Array.isArray(shas) || shas.length === 0) {
    throw new Error('buildUpdateStampSql called with empty sha list');
  }
  validateIsoTimestamp(timestamp);
  for (const s of shas) validateSha256(s);
  const inList = shas.map(s => `'${s}'`).join(', ');
  return (
    `UPDATE creator_deletions SET physical_deleted_at = '${timestamp}'` +
    ` WHERE blob_sha256 IN (${inList})` +
    ` AND physical_deleted_at IS NULL;`
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — all parseArgs + SQL-builder tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): SQL builders for candidates/unprocessable/perm-failures/stamp"
```

---

## Task 4: runWithConcurrency

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import { runWithConcurrency } from './sweep-creator-deletes.mjs';

describe('runWithConcurrency', () => {
  it('runs all items and returns one result per input', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 2, async x => x * 10);
    expect(results.length).toBe(5);
    expect(results.map(r => r.value).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects concurrency cap (never more than N in flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    };
    await runWithConcurrency(new Array(20).fill(0), 3, work);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('isolates per-item errors — one failure does not poison the rest', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrency(items, 2, async x => {
      if (x === 2) throw new Error('boom');
      return x;
    });
    expect(results.length).toBe(3);
    const byInput = Object.fromEntries(results.map(r => [r.input, r]));
    expect(byInput[1].value).toBe(1);
    expect(byInput[2].error.message).toBe('boom');
    expect(byInput[3].value).toBe(3);
  });

  it('returns immediately on empty input', async () => {
    const results = await runWithConcurrency([], 5, async () => { throw new Error('should not run'); });
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — `runWithConcurrency` not exported.

- [ ] **Step 3: Implement runWithConcurrency**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
export async function runWithConcurrency(items, concurrency, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const input = items[i];
      try {
        const value = await fn(input);
        results[i] = { input, value };
      } catch (error) {
        results[i] = { input, error };
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — concurrency tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): bounded-concurrency worker pool"
```

---

## Task 5: callBlossomDelete + classifyDeleteResult (wraps notifyBlossom)

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import { callBlossomDelete, classifyDeleteResult } from './sweep-creator-deletes.mjs';

const SHA_C = 'c'.repeat(64);

function makeFakeNotify(impl) {
  const calls = [];
  const fn = async (sha256, action, env) => {
    calls.push({ sha256, action, env });
    return impl({ sha256, action, env });
  };
  fn.calls = calls;
  return fn;
}

describe('callBlossomDelete', () => {
  it('passes sha + DELETE + env to notifyBlossom and returns a normalized result', async () => {
    const notify = makeFakeNotify(() => ({
      success: true,
      status: 200,
      result: { status: 'success', physical_delete_enabled: true, physical_deleted: true }
    }));
    const cfg = {
      blossomWebhookUrl: 'https://example/admin/moderate',
      blossomWebhookSecret: 'secret-xyz'
    };
    const r = await callBlossomDelete(SHA_C, cfg, notify);
    expect(notify.calls).toEqual([{
      sha256: SHA_C,
      action: 'DELETE',
      env: { BLOSSOM_WEBHOOK_URL: cfg.blossomWebhookUrl, BLOSSOM_WEBHOOK_SECRET: cfg.blossomWebhookSecret }
    }]);
    expect(r.ok).toBe(true);
    expect(r.body.physical_deleted).toBe(true);
  });

  it('surfaces network error from notifyBlossom', async () => {
    const notify = makeFakeNotify(() => ({ success: false, networkError: true, error: 'ECONNRESET' }));
    const r = await callBlossomDelete(SHA_C, { blossomWebhookUrl: 'u', blossomWebhookSecret: 's' }, notify);
    expect(r.ok).toBe(false);
    expect(r.networkError).toBe(true);
  });

  it('surfaces 5xx HTTP error', async () => {
    const notify = makeFakeNotify(() => ({ success: false, error: 'HTTP 502: bad', status: 502 }));
    const r = await callBlossomDelete(SHA_C, { blossomWebhookUrl: 'u', blossomWebhookSecret: 's' }, notify);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
  });
});

describe('classifyDeleteResult', () => {
  it('success when ok && body.status==="success" && body.physical_deleted===true', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'success', physical_delete_enabled: true, physical_deleted: true }
    })).toEqual({ kind: 'success' });
  });

  it('flag-off pre-flight signal when physical_delete_enabled===false', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'success', physical_delete_enabled: false, physical_deleted: false }
    })).toEqual({ kind: 'flag-off' });
  });

  it('failure when body.status==="error"', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'error', error: 'gcs delete failed' }
    })).toEqual({ kind: 'failure', reason: 'gcs delete failed' });
  });

  it('failure when 200 but physical_deleted===false (and flag was on)', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'success', physical_delete_enabled: true, physical_deleted: false }
    })).toEqual({ kind: 'failure', reason: 'physical_deleted=false despite flag on' });
  });

  it('auth-failure on 401/403', () => {
    expect(classifyDeleteResult({ ok: false, status: 401 })).toEqual({ kind: 'auth-failure' });
    expect(classifyDeleteResult({ ok: false, status: 403 })).toEqual({ kind: 'auth-failure' });
  });

  it('unreachable on 5xx', () => {
    expect(classifyDeleteResult({ ok: false, status: 502 }).kind).toBe('unreachable');
  });

  it('unreachable on networkError', () => {
    expect(classifyDeleteResult({ ok: false, networkError: true, error: 'ECONNRESET' }).kind).toBe('unreachable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — `callBlossomDelete` and `classifyDeleteResult` not exported.

- [ ] **Step 3: Implement the wrappers**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
import { notifyBlossom as defaultNotify } from '../src/blossom-client.mjs';

/**
 * Wraps notifyBlossom() so the script reuses the live-pipeline request shape and headers.
 * notifyImpl is injectable for tests.
 */
export async function callBlossomDelete(sha256, cfg, notifyImpl = defaultNotify) {
  const env = {
    BLOSSOM_WEBHOOK_URL: cfg.blossomWebhookUrl,
    BLOSSOM_WEBHOOK_SECRET: cfg.blossomWebhookSecret
  };
  const r = await notifyImpl(sha256, 'DELETE', env);
  if (r.success) {
    return { ok: true, status: r.status, body: r.result };
  }
  return {
    ok: false,
    status: r.status,
    networkError: !!r.networkError,
    error: r.error
  };
}

/**
 * Classifies a Blossom call result into the action the script should take.
 * Used by both pre-flight and per-row sweep logic.
 */
export function classifyDeleteResult(r) {
  if (r.ok) {
    const b = r.body || {};
    if (b.physical_delete_enabled === false) return { kind: 'flag-off' };
    if (b.status === 'error') return { kind: 'failure', reason: b.error || 'blossom returned status=error' };
    if (b.status === 'success' && b.physical_deleted === true) return { kind: 'success' };
    return { kind: 'failure', reason: 'physical_deleted=false despite flag on' };
  }
  if (r.status === 401 || r.status === 403) return { kind: 'auth-failure' };
  if (r.networkError) return { kind: 'unreachable', reason: r.error || 'network error' };
  if (r.status >= 500) return { kind: 'unreachable', reason: `HTTP ${r.status}` };
  return { kind: 'failure', reason: r.error || `HTTP ${r.status}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — Blossom-call and classifier tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): callBlossomDelete + classifyDeleteResult (reuses notifyBlossom)"
```

---

## Task 6: Wrangler shell-out wrappers (fetchCandidates / fetchUnprocessable / fetchPermanentFailures / flushDeletedAt)

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import {
  fetchCandidates,
  fetchUnprocessable,
  fetchPermanentFailures,
  flushDeletedAt
} from './sweep-creator-deletes.mjs';

function makeFakeRunner(responseFor) {
  const calls = [];
  const fn = async ({ command, args }) => {
    calls.push({ command, args });
    const sql = args[args.indexOf('--command') + 1];
    return responseFor(sql);
  };
  fn.calls = calls;
  return fn;
}

const WRANGLER_RESULT_ENVELOPE = (rows) => JSON.stringify([{ results: rows, success: true, meta: {} }]);

describe('fetchCandidates', () => {
  it('shells wrangler with the right command, db, and SQL; parses results', async () => {
    const runner = makeFakeRunner(() => ({
      stdout: WRANGLER_RESULT_ENVELOPE([
        { kind5_id: 'k1', target_event_id: 't1', blob_sha256: 'a'.repeat(64), completed_at: '2026-04-15T00:00:00Z' }
      ]),
      stderr: '',
      status: 0
    }));
    const cfg = parseArgs([]);
    const rows = await fetchCandidates(cfg, runner);
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0].command).toBe('wrangler');
    expect(runner.calls[0].args.slice(0, 5)).toEqual(['d1', 'execute', cfg.d1Database, '--remote', '--json']);
    expect(runner.calls[0].args[5]).toBe('--command');
    expect(runner.calls[0].args[6]).toContain("WHERE status = 'success'");
    expect(rows).toEqual([
      { kind5_id: 'k1', target_event_id: 't1', blob_sha256: 'a'.repeat(64), completed_at: '2026-04-15T00:00:00Z' }
    ]);
  });

  it('returns empty array when wrangler result envelope has zero rows', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    const rows = await fetchCandidates(parseArgs([]), runner);
    expect(rows).toEqual([]);
  });

  it('throws when wrangler exits non-zero', async () => {
    const runner = makeFakeRunner(() => ({ stdout: '', stderr: 'auth required', status: 1 }));
    await expect(fetchCandidates(parseArgs([]), runner)).rejects.toThrow(/auth required/i);
  });

  it('throws when wrangler stdout is not parseable JSON', async () => {
    const runner = makeFakeRunner(() => ({ stdout: 'not json', stderr: '', status: 0 }));
    await expect(fetchCandidates(parseArgs([]), runner)).rejects.toThrow(/parse/i);
  });
});

describe('fetchUnprocessable', () => {
  it('queries for status=success AND blob_sha256 IS NULL', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await fetchUnprocessable(parseArgs([]), runner);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain('blob_sha256 IS NULL');
  });
});

describe('fetchPermanentFailures', () => {
  it("queries for status LIKE 'failed:permanent:%'", async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await fetchPermanentFailures(parseArgs([]), runner);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain("'failed:permanent:%'");
  });
});

describe('flushDeletedAt', () => {
  it('builds and runs UPDATE with the supplied shas + timestamp', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    const ts = '2026-04-17T20:00:00.000Z';
    await flushDeletedAt(['a'.repeat(64), 'b'.repeat(64)], parseArgs([]), runner, ts);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain(`SET physical_deleted_at = '${ts}'`);
    expect(sql).toContain(`'${'a'.repeat(64)}'`);
    expect(sql).toContain(`'${'b'.repeat(64)}'`);
  });

  it('is a no-op on empty sha list', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await flushDeletedAt([], parseArgs([]), runner, '2026-04-17T20:00:00.000Z');
    expect(runner.calls.length).toBe(0);
  });

  it('throws when wrangler exits non-zero', async () => {
    const runner = makeFakeRunner(() => ({ stdout: '', stderr: 'd1 unreachable', status: 1 }));
    await expect(flushDeletedAt(['a'.repeat(64)], parseArgs([]), runner, '2026-04-17T20:00:00.000Z'))
      .rejects.toThrow(/d1 unreachable/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — none of the four wrangler-shell wrappers exist.

- [ ] **Step 3: Implement the wrappers + a default runner**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
import { spawnSync } from 'node:child_process';

/**
 * Default runner used when the script runs as a CLI. Tests inject a fake.
 * Uses spawnSync (not the shell-interpreting variant) — args is an array, not a string.
 */
export function defaultRunner({ command, args }) {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? 0 };
}

async function runWranglerD1(cfg, sql, runner) {
  const args = ['d1', 'execute', cfg.d1Database, '--remote', '--json', '--command', sql];
  const r = await runner({ command: 'wrangler', args });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`failed to parse wrangler stdout as JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || !parsed[0]) return [];
  return parsed[0].results || [];
}

export async function fetchCandidates(cfg, runner = defaultRunner) {
  const sql = buildSelectCandidatesSql({ since: cfg.since, until: cfg.until, limit: cfg.limit });
  return runWranglerD1(cfg, sql, runner);
}

export async function fetchUnprocessable(cfg, runner = defaultRunner) {
  return runWranglerD1(cfg, buildSelectUnprocessableSql(), runner);
}

export async function fetchPermanentFailures(cfg, runner = defaultRunner) {
  return runWranglerD1(cfg, buildSelectPermanentFailuresSql(), runner);
}

export async function flushDeletedAt(shas, cfg, runner = defaultRunner, timestamp = new Date().toISOString()) {
  if (!shas || shas.length === 0) return;
  const sql = buildUpdateStampSql(shas, timestamp);
  await runWranglerD1(cfg, sql, runner);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — all wrangler-shell wrapper tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): wrangler d1 wrappers (fetch candidates/unprocessable/perm-failures + flush)"
```

---

## Task 7: Pre-flight handler

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import { runPreflight, PreflightAbort } from './sweep-creator-deletes.mjs';

describe('runPreflight', () => {
  const SHA = 'd'.repeat(64);
  const cfg = parseArgs([]);

  it('returns success for the first row when Blossom returns physical_deleted=true', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { status: 'success', physical_delete_enabled: true, physical_deleted: true }
    }));
    const out = await runPreflight(SHA, cfg, notify);
    expect(out).toEqual({ kind: 'success' });
    expect(notify.calls.length).toBe(1);
  });

  it('throws PreflightAbort with reason="flag-off" when physical_delete_enabled is false', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { status: 'success', physical_delete_enabled: false, physical_deleted: false }
    }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'flag-off'
    });
  });

  it('throws PreflightAbort with reason="auth-failure" on 401', async () => {
    const notify = makeFakeNotify(() => ({ success: false, status: 401, error: 'unauthorized' }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'auth-failure'
    });
  });

  it('throws PreflightAbort with reason="unreachable" on 502', async () => {
    const notify = makeFakeNotify(() => ({ success: false, status: 502, error: 'bad gateway' }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'unreachable'
    });
  });

  it('throws PreflightAbort with reason="unreachable" on network error', async () => {
    const notify = makeFakeNotify(() => ({ success: false, networkError: true, error: 'ECONNRESET' }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'unreachable'
    });
  });

  it('throws PreflightAbort with reason="failure" when Blossom returns 200 status:error', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { status: 'error', error: 'gcs delete failed' }
    }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'failure'
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — `runPreflight` and `PreflightAbort` not exported.

- [ ] **Step 3: Implement runPreflight + PreflightAbort**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
export class PreflightAbort extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'PreflightAbort';
    this.reason = reason;
  }
}

export async function runPreflight(sha256, cfg, notifyImpl = defaultNotify) {
  const r = await callBlossomDelete(sha256, cfg, notifyImpl);
  const c = classifyDeleteResult(r);
  if (c.kind === 'success') return { kind: 'success' };
  if (c.kind === 'flag-off') {
    throw new PreflightAbort('flag-off',
      'Blossom did not byte-delete because ENABLE_PHYSICAL_DELETE is off. ' +
      'Flip the flag in Blossom config store before sweeping. No D1 writes occurred.');
  }
  if (c.kind === 'auth-failure') {
    throw new PreflightAbort('auth-failure',
      'Blossom rejected auth — check BLOSSOM_WEBHOOK_SECRET. No D1 writes occurred.');
  }
  if (c.kind === 'unreachable') {
    throw new PreflightAbort('unreachable',
      `Blossom unreachable: ${c.reason}. No D1 writes occurred.`);
  }
  throw new PreflightAbort('failure',
    `Blossom returned a failure on the first candidate: ${c.reason}. No D1 writes occurred.`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — pre-flight tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): pre-flight check (flag/auth/unreachable abort with structured reasons)"
```

---

## Task 8: Sweep orchestrator + summary + exit-code

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import { sweepCandidates, summarize, computeExitCode } from './sweep-creator-deletes.mjs';

describe('sweepCandidates', () => {
  const cfg = parseArgs(['--concurrency=2']);
  const rowFor = (sha) => ({ kind5_id: `k-${sha.slice(0,4)}`, target_event_id: `t-${sha.slice(0,4)}`, blob_sha256: sha, completed_at: '2026-04-15T00:00:00Z' });

  it('stamps shas where Blossom returned physical_deleted=true', async () => {
    const okBody = { status: 'success', physical_delete_enabled: true, physical_deleted: true };
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const candidates = ['a','b','c'].map(c => rowFor(c.repeat(64)));
    const out = await sweepCandidates(candidates, cfg, notify, flushImpl);
    expect(out.successes.length).toBe(3);
    expect(out.failures.length).toBe(0);
    expect(flushed.sort()).toEqual(candidates.map(r => r.blob_sha256).sort());
  });

  it('does NOT stamp shas when physical_deleted=false (even on HTTP 200)', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { status: 'success', physical_delete_enabled: true, physical_deleted: false }
    }));
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const out = await sweepCandidates([rowFor('e'.repeat(64))], cfg, notify, flushImpl);
    expect(out.successes.length).toBe(0);
    expect(out.failures.length).toBe(1);
    expect(flushed).toEqual([]);
  });

  it('isolates per-row failures — successful rows still stamp', async () => {
    const notify = makeFakeNotify(({ sha256 }) => {
      if (sha256.startsWith('b')) return { success: false, status: 502, error: 'bad gateway' };
      return { success: true, status: 200, result: { status: 'success', physical_delete_enabled: true, physical_deleted: true } };
    });
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const candidates = ['a','b','c'].map(c => rowFor(c.repeat(64)));
    const out = await sweepCandidates(candidates, cfg, notify, flushImpl);
    expect(out.successes.length).toBe(2);
    expect(out.failures.length).toBe(1);
    expect(flushed.sort()).toEqual([candidates[0].blob_sha256, candidates[2].blob_sha256].sort());
  });

  it('flushes in batches of FLUSH_BATCH_SIZE (default 100)', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { status: 'success', physical_delete_enabled: true, physical_deleted: true }
    }));
    const batches = [];
    const flushImpl = async (shas) => { batches.push(shas.length); };
    // 250 candidates → flushes of 100, 100, 50
    const candidates = Array.from({ length: 250 }, (_, i) => rowFor(i.toString(16).padStart(64, '0')));
    await sweepCandidates(candidates, cfg, notify, flushImpl);
    expect(batches).toEqual([100, 100, 50]);
  });
});

describe('summarize', () => {
  it('aggregates counts and lists for printing', () => {
    const result = summarize({
      candidates: [{ blob_sha256: 'a'.repeat(64) }],
      successes: [{ blob_sha256: 'a'.repeat(64) }],
      failures: [],
      unprocessable: [{ kind5_id: 'k1' }],
      permanentFailures: []
    });
    expect(result).toMatchObject({
      total: 1,
      stamped: 1,
      failed: 0,
      unprocessableCount: 1,
      permanentFailureCount: 0
    });
  });
});

describe('computeExitCode', () => {
  it('returns 0 when nothing failed and no unprocessable / perm-failures', () => {
    expect(computeExitCode({ failed: 0, unprocessableCount: 0, permanentFailureCount: 0 })).toBe(0);
  });
  it('returns 1 when failures exist', () => {
    expect(computeExitCode({ failed: 1, unprocessableCount: 0, permanentFailureCount: 0 })).toBe(1);
  });
  it('returns 1 when unprocessable rows exist', () => {
    expect(computeExitCode({ failed: 0, unprocessableCount: 1, permanentFailureCount: 0 })).toBe(1);
  });
  it('returns 1 when permanent failures exist', () => {
    expect(computeExitCode({ failed: 0, unprocessableCount: 0, permanentFailureCount: 1 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — `sweepCandidates`, `summarize`, `computeExitCode` not exported.

- [ ] **Step 3: Implement sweep orchestrator + summary + exit code**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
function nowIso() {
  return new Date().toISOString();
}

function emitJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Bulk sweep over candidates. Stamps via flushImpl in batches of FLUSH_BATCH_SIZE.
 * Per-row JSONL outcome lines are emitted to stdout for grep/jq.
 *
 * Returns { successes, failures } as arrays of {row, body?, error?, status?}.
 */
export async function sweepCandidates(candidates, cfg, notifyImpl = defaultNotify, flushImpl = null) {
  const successes = [];
  const failures = [];
  let pending = [];
  const flush = flushImpl || (async (shas) => { await flushDeletedAt(shas, cfg); });

  const results = await runWithConcurrency(candidates, cfg.concurrency, async (row) => {
    return callBlossomDelete(row.blob_sha256, cfg, notifyImpl);
  });

  for (const r of results) {
    const row = r.input;
    if (r.error) {
      failures.push({ row, error: r.error.message });
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'failure', error: r.error.message });
      continue;
    }
    const c = classifyDeleteResult(r.value);
    if (c.kind === 'success') {
      successes.push({ row, body: r.value.body });
      pending.push(row.blob_sha256);
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'success', http: r.value.status, physical_deleted: true });
      if (pending.length >= FLUSH_BATCH_SIZE) {
        await flush(pending);
        pending = [];
      }
    } else {
      failures.push({ row, error: c.reason || c.kind, status: r.value.status });
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'failure', http: r.value.status, error: c.reason || c.kind });
    }
  }

  if (pending.length > 0) {
    await flush(pending);
  }
  return { successes, failures };
}

export function summarize({ candidates, successes, failures, unprocessable, permanentFailures }) {
  return {
    total: candidates.length,
    stamped: successes.length,
    failed: failures.length,
    unprocessableCount: unprocessable.length,
    permanentFailureCount: permanentFailures.length,
    successes,
    failures,
    unprocessable,
    permanentFailures
  };
}

export function computeExitCode(s) {
  if (s.failed > 0 || s.unprocessableCount > 0 || s.permanentFailureCount > 0) return 1;
  return 0;
}

export function printSummary(s) {
  process.stdout.write('\n=== SUMMARY ===\n');
  process.stdout.write(`Total candidates fetched:      ${s.total}\n`);
  process.stdout.write(`Bytes destroyed + stamped:     ${s.stamped}\n`);
  process.stdout.write(`Failed (will retry next run):  ${s.failed}\n`);
  process.stdout.write(`Unprocessable (NULL sha256):   ${s.unprocessableCount}\n`);
  process.stdout.write(`Permanent failures (manual):   ${s.permanentFailureCount}\n`);

  if (s.failures.length > 0) {
    process.stdout.write('\n=== FAILURES (will retry) ===\n');
    for (const f of s.failures) {
      process.stdout.write(`sha=${f.row.blob_sha256} http=${f.status ?? '-'} kind5=${f.row.kind5_id}: ${f.error}\n`);
    }
  }
  if (s.unprocessable.length > 0) {
    process.stdout.write('\n=== UNPROCESSABLE (creator intent unfulfilled, NULL sha256) ===\n');
    for (const u of s.unprocessable) {
      process.stdout.write(`kind5=${u.kind5_id} target=${u.target_event_id} creator=${u.creator_pubkey} completed_at=${u.completed_at}\n`);
    }
  }
  if (s.permanentFailures.length > 0) {
    process.stdout.write('\n=== PERMANENT FAILURES (creator intent unfulfilled, status=failed:permanent:*) ===\n');
    for (const p of s.permanentFailures) {
      process.stdout.write(`kind5=${p.kind5_id} target=${p.target_event_id} creator=${p.creator_pubkey} status=${p.status} last_error=${p.last_error}\n`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — sweep + summary + exit-code tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): orchestrator (per-row JSONL, batched flush, summary, exit-code)"
```

---

## Task 9: main() integration

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`
- Modify: `scripts/sweep-creator-deletes.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sweep-creator-deletes.test.mjs`:

```js
import { main } from './sweep-creator-deletes.mjs';

describe('main (integration)', () => {
  const candidateRow = { kind5_id: 'k1', target_event_id: 't1', blob_sha256: 'a'.repeat(64), completed_at: '2026-04-15T00:00:00Z' };
  const okBody = { status: 'success', physical_delete_enabled: true, physical_deleted: true };

  function makeRunnerForResults({ candidates = [], unprocessable = [], permanentFailures = [], updates = () => ({stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0}) } = {}) {
    return async ({ command, args }) => {
      const sql = args[args.indexOf('--command') + 1];
      if (sql.startsWith('SELECT kind5_id, target_event_id, blob_sha256')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(candidates), stderr: '', status: 0 };
      }
      if (sql.includes('blob_sha256 IS NULL')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(unprocessable), stderr: '', status: 0 };
      }
      if (sql.includes("'failed:permanent:%'")) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(permanentFailures), stderr: '', status: 0 };
      }
      if (sql.startsWith('UPDATE creator_deletions')) {
        return updates(sql);
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    };
  }

  it('dry-run: prints candidates, makes zero notify or D1-write calls', async () => {
    const notify = makeFakeNotify(() => { throw new Error('should not be called in dry-run'); });
    let updateCalls = 0;
    const runner = makeRunnerForResults({
      candidates: [candidateRow],
      updates: () => { updateCalls++; return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }; }
    });
    const code = await main(['--dry-run'], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(notify.calls.length).toBe(0);
    expect(updateCalls).toBe(0);
    expect(code).toBe(0);
  });

  it('pre-flight flag-off: aborts with exit 2 and zero D1 writes', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { status: 'success', physical_delete_enabled: false, physical_deleted: false }
    }));
    let updateCalls = 0;
    const runner = makeRunnerForResults({
      candidates: [candidateRow],
      updates: () => { updateCalls++; return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }; }
    });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(notify.calls.length).toBe(1);
    expect(updateCalls).toBe(0);
    expect(code).toBe(2);
  });

  it('pre-flight 401: aborts with exit 2', async () => {
    const notify = makeFakeNotify(() => ({ success: false, status: 401, error: 'unauthorized' }));
    const runner = makeRunnerForResults({ candidates: [candidateRow] });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(2);
  });

  it('successful sweep: stamps all rows, exit 0', async () => {
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const runner = makeRunnerForResults({ candidates: [candidateRow] });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(0);
  });

  it('per-row failure: continues sweep, exit 1', async () => {
    const candidates = ['a', 'b'].map(c => ({ ...candidateRow, blob_sha256: c.repeat(64), kind5_id: `k-${c}`, target_event_id: `t-${c}` }));
    const notify = makeFakeNotify(({ sha256 }) => {
      if (sha256.startsWith('b')) return { success: false, status: 502, error: 'bad gateway' };
      return { success: true, status: 200, result: okBody };
    });
    const runner = makeRunnerForResults({ candidates });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(1);
  });

  it('empty-candidates short-circuit: still surfaces unprocessable + perm-failures', async () => {
    const notify = makeFakeNotify(() => { throw new Error('should not be called'); });
    const runner = makeRunnerForResults({
      candidates: [],
      unprocessable: [{ kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', completed_at: '2026-04-15T00:00:00Z' }],
      permanentFailures: []
    });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(notify.calls.length).toBe(0);
    expect(code).toBe(1); // unprocessable triggers exit 1
  });

  it('empty everywhere: exit 0', async () => {
    const notify = makeFakeNotify(() => { throw new Error('should not be called'); });
    const runner = makeRunnerForResults({ candidates: [], unprocessable: [], permanentFailures: [] });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: FAIL — `main` not exported.

- [ ] **Step 3: Implement main()**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
function readBlossomSecret() {
  const s = process.env.BLOSSOM_WEBHOOK_SECRET;
  if (!s) {
    throw new Error('BLOSSOM_WEBHOOK_SECRET env var is required');
  }
  return s;
}

/**
 * Programmatic entrypoint. Returns the exit code (does not call process.exit).
 * Tests inject { runner, notify, blossomWebhookSecret } to drive the flow without shelling out.
 */
export async function main(argv, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const notify = deps.notify || defaultNotify;

  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`arg error: ${e.message}\n`);
    return 3;
  }

  try {
    cfg.blossomWebhookSecret = deps.blossomWebhookSecret ?? readBlossomSecret();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 3;
  }

  // 1. Fetch candidates
  let candidates;
  try {
    candidates = await fetchCandidates(cfg, runner);
  } catch (e) {
    process.stderr.write(`fetchCandidates failed: ${e.message}\n`);
    return 3;
  }
  process.stderr.write(`Found ${candidates.length} candidate(s) for sweep.\n`);
  if (cfg.since || cfg.until) {
    process.stderr.write(`Window: since=${cfg.since ?? '-'} until=${cfg.until ?? '-'}\n`);
  }

  // 2. Dry-run gate
  if (cfg.dryRun) {
    for (const r of candidates.slice(0, 20)) {
      process.stdout.write(`[dry-run] sha=${r.blob_sha256} kind5=${r.kind5_id} completed_at=${r.completed_at}\n`);
    }
    if (candidates.length > 20) {
      process.stdout.write(`[dry-run] ... and ${candidates.length - 20} more\n`);
    }
    return 0;
  }

  // 3. Pre-flight (consumes the first candidate when there are any)
  let preflightSuccess = null;
  if (candidates.length > 0) {
    try {
      preflightSuccess = await runPreflight(candidates[0].blob_sha256, cfg, notify);
    } catch (e) {
      if (e instanceof PreflightAbort) {
        process.stderr.write(`preflight aborted (${e.reason}): ${e.message}\n`);
        return 2;
      }
      process.stderr.write(`preflight error: ${e.message}\n`);
      return 2;
    }
  }

  // 4. Sweep remaining (skip the pre-flight row, then re-add it as a success)
  let sweepResult = { successes: [], failures: [] };
  if (candidates.length > 0) {
    const remaining = candidates.slice(1);
    sweepResult = await sweepCandidates(remaining, cfg, notify, async (shas) => {
      await flushDeletedAt(shas, cfg, runner);
    });
    if (preflightSuccess) {
      sweepResult.successes.unshift({ row: candidates[0], body: null });
      await flushDeletedAt([candidates[0].blob_sha256], cfg, runner);
      emitJsonLine({ ts: nowIso(), sha: candidates[0].blob_sha256, kind5: candidates[0].kind5_id, target: candidates[0].target_event_id, outcome: 'success', http: 200, physical_deleted: true, source: 'preflight' });
    }
  }

  // 5. Surfacing queries
  let unprocessable = [];
  let permanentFailures = [];
  try {
    unprocessable = await fetchUnprocessable(cfg, runner);
    permanentFailures = await fetchPermanentFailures(cfg, runner);
  } catch (e) {
    process.stderr.write(`surfacing query failed: ${e.message}\n`);
    // continue — print summary with what we have
  }

  // 6. Summary
  const s = summarize({
    candidates,
    successes: sweepResult.successes,
    failures: sweepResult.failures,
    unprocessable,
    permanentFailures
  });
  printSummary(s);
  return computeExitCode(s);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/sweep-creator-deletes.test.mjs`

Expected: PASS — all integration tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs scripts/sweep-creator-deletes.test.mjs
git commit -m "feat(sweep): main() orchestrator with pre-flight + dry-run + surfacing"
```

---

## Task 10: SIGINT drain handler + CLI entrypoint

**Files:**
- Modify: `scripts/sweep-creator-deletes.mjs`

This task has no unit-testable surface beyond the shape — SIGINT in vitest under the Workers pool is unreliable. Implementation only.

- [ ] **Step 1: Add SIGINT-aware draining flag and CLI entrypoint**

Append to `scripts/sweep-creator-deletes.mjs`:

```js
// SIGINT handling — best-effort drain.
// First SIGINT: set DRAINING flag; the orchestrator stops scheduling new flushes once the current
// runWithConcurrency batch settles, then exits with the partial summary.
// Second SIGINT: hard exit 130.
let DRAINING = false;
let SIGINT_COUNT = 0;

function installSigintHandler() {
  process.on('SIGINT', () => {
    SIGINT_COUNT++;
    if (SIGINT_COUNT === 1) {
      DRAINING = true;
      process.stderr.write('\n[sweep] SIGINT received — draining in-flight work; press Ctrl-C again to abort.\n');
    } else {
      process.stderr.write('\n[sweep] SIGINT received twice — exiting now.\n');
      process.exit(130);
    }
  });
}

export function isDraining() { return DRAINING; }

// CLI entrypoint — only runs when invoked directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  installSigintHandler();
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`unexpected error: ${err.stack || err.message}\n`);
      process.exit(99);
    }
  );
}
```

Then modify the `for (const r of results)` loop in `sweepCandidates` (Task 8) to short-circuit on draining. The two-line change:

```js
  for (const r of results) {
    if (isDraining()) break;  // <- new line at top of loop body
    const row = r.input;
    // ... rest unchanged
  }
```

The `break` is the simplest correct draining behavior: once draining, we stop processing further results, flush whatever is pending, and let main() return its summary. In-flight Blossom calls (within `runWithConcurrency`) have already settled by the time we reach this loop — so the draining check between iterations is the right granularity.

- [ ] **Step 2: Sanity check the script can be imported without side effects**

Run: `node -e "import('./scripts/sweep-creator-deletes.mjs').then(m => console.log(Object.keys(m).sort().join(',')))"`

Expected: prints comma-separated export names. No SIGINT handler installed, no main() invoked, no shell-out.

- [ ] **Step 3: Sanity check CLI invocation fails fast without env**

Run (with `BLOSSOM_WEBHOOK_SECRET` unset): `unset BLOSSOM_WEBHOOK_SECRET && node scripts/sweep-creator-deletes.mjs --dry-run`

Expected: prints `BLOSSOM_WEBHOOK_SECRET env var is required`. Exit code 3.

- [ ] **Step 4: Commit**

```bash
git add scripts/sweep-creator-deletes.mjs
git commit -m "feat(sweep): SIGINT drain handler + CLI entrypoint"
```

---

## Task 11: Lint + full test pass + branch push + draft PR

**Files:** none (verification only)

- [ ] **Step 1: Run the linter**

Run: `npm run lint`

Expected: clean (no errors). If errors are flagged on the new files, fix and re-run.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all tests green. The new sweep tests should add ~30 new test cases. If pre-existing tests fail, investigate — probably an unrelated regression unless the new files leak globals.

- [ ] **Step 3: Push the branch**

Run: `git push -u origin spec/creator-delete-validation-sweep`

Expected: branch published. CI runs.

- [ ] **Step 4: Open a draft PR**

Run:

```bash
gh pr create --draft --title "feat(sweep): creator-delete validation-window physical-delete sweep" --body "Closes divinevideo/divine-blossom#90.

Spec: docs/superpowers/specs/2026-04-17-creator-delete-validation-sweep-design.md
Plan: docs/superpowers/plans/2026-04-17-creator-delete-validation-sweep-plan.md

## Summary

Operator-run script that backfills physical byte deletion for creator-delete kind 5 events whose Blossom soft-delete completed during the ENABLE_PHYSICAL_DELETE=false validation window.

- New D1 column \`physical_deleted_at\` on \`creator_deletions\` (migration 007).
- New script \`scripts/sweep-creator-deletes.mjs\`: reads candidates from D1, calls Blossom DELETE via the existing \`notifyBlossom()\` client, stamps the column on confirmed byte destruction.
- Pre-flight aborts (exit 2) if \`ENABLE_PHYSICAL_DELETE\` is off, auth fails, or Blossom is unreachable — zero D1 writes in that case.
- Surfaces unprocessable rows (status=success, NULL sha) and permanent failures (status=failed:permanent:*) in the summary so creator intent we can't fulfill is loud, not silent.

## Test plan

- [x] Unit + integration tests via vitest (~30 new cases)
- [x] Lint clean
- [ ] Local dry-run against prod D1 (after merge, before sweep run)
- [ ] First real sweep run (deferred to rollout)
"
```

Then: `gh pr checks <PR-number>` — wait for CI to settle.

Expected: PR opened in draft, all CI checks pass.

---

## Task 12: Local smoke check (manual, post-PR)

**Files:** none (operational verification, do not block plan completion)

This is the wiring-in-reality check. Defer until the PR is approved and you're ready to use the sweep for real.

- [ ] **Step 1: Apply the migration to local D1**

Run: `wrangler d1 execute divine-moderation-decisions-prod --file migrations/007-creator-deletions-physical-deleted-at.sql --local`

Expected: `Executed 1 command in 0.NNs.` confirming the column was added.

- [ ] **Step 2: Apply the migration to prod D1**

Run: `wrangler d1 execute divine-moderation-decisions-prod --file migrations/007-creator-deletions-physical-deleted-at.sql --remote`

Expected: same success line. Verifiable via `wrangler d1 execute divine-moderation-decisions-prod --command "PRAGMA table_info(creator_deletions);" --remote`.

- [ ] **Step 3: Dry-run against prod (read-only)**

Run: `BLOSSOM_WEBHOOK_SECRET=<value> node scripts/sweep-creator-deletes.mjs --dry-run`

Expected: prints candidate count + first 20 shas + window. No network calls, no D1 writes (verifiable in Cloudflare D1 dashboard query log).

- [ ] **Step 4: Stop here and hand off to the rollout**

Real execution waits for the rollout document update (see `support-trust-safety/docs/rollout/2026-04-16-creator-delete-rollout.md`). The sweep itself is the operational e2e.

---

## Self-review notes

**Spec coverage check:**

| Spec section | Implementing task |
|---|---|
| Migration 007 | Task 1 |
| `parseArgs` | Task 2 |
| SQL builders + sha256 hex validation | Task 3 |
| `runWithConcurrency` | Task 4 |
| `callBlossomDelete` (reuses notifyBlossom) | Task 5 |
| Pre-flight (flag-off / auth / unreachable) | Task 7 |
| `fetchCandidates` / `fetchUnprocessable` / `fetchPermanentFailures` | Task 6 |
| `flushDeletedAt` (batched, idempotency guard) | Task 6 |
| Strict success criterion (`physical_deleted === true`) | Tasks 5 + 8 |
| JSONL per-row outcome log | Task 8 |
| Surfacing unfulfilled creator intent (NULL sha + perm-failures) | Task 9 |
| Summary + exit codes (0 / 1 / 2 / 3) | Tasks 8 + 9 |
| Empty-candidates short-circuit | Task 9 |
| SIGINT best-effort drain | Task 10 |
| CLI entrypoint + lint + CI | Tasks 10 + 11 |
| Manual smoke check | Task 12 |

The spec lists exit code 4 (D1 write aborted mid-run) and 130 (SIGINT). Exit 4 is implicitly returned because `flushDeletedAt` throws and main() does not catch — the unhandled rejection in Task 10's CLI wrapper exits 99. If the spec's exit code 4 turns out to matter to operators, add an explicit catch around `sweepCandidates` and surface code 4 in main(). Defer until ops asks.

130 is provided by the SIGINT handler in Task 10 (only on second SIGINT; first SIGINT exits 0/1 via the normal summary path after draining).

**Type consistency check:**

- `parseArgs` returns object with `dryRun, since, until, concurrency, limit, blossomWebhookUrl, d1Database` — used consistently across `fetchCandidates`, `runPreflight`, `sweepCandidates`, `flushDeletedAt`. `main()` adds `blossomWebhookSecret` to the same object before passing it on; downstream readers expect the augmented shape.
- `callBlossomDelete` returns `{ok, status, body, networkError?, error?}` — consumed by `classifyDeleteResult` and `runPreflight`, both expect that shape.
- `sweepCandidates` returns `{successes, failures}` arrays of `{row, body?/error}` — `summarize` and `printSummary` index into `successes` and `failures` correctly.
- `summarize` returns `{total, stamped, failed, unprocessableCount, permanentFailureCount, successes, failures, unprocessable, permanentFailures}` — `computeExitCode` reads three of these; `printSummary` reads all.
- `PreflightAbort.reason` is a string; `main()` reads `instanceof PreflightAbort` then `.reason` and `.message`. Matches.

**Placeholder scan:** no TBD/TODO/incomplete sections. Each step shows the exact code or command. The "deferred until ops asks" note for exit code 4 is an explicit YAGNI choice with a follow-up trigger, not a hidden gap.
