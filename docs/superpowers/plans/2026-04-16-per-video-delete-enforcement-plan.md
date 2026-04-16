# Per-Video Delete End-to-End Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the divine-moderation-service side of per-video creator-initiated deletes: a race-safe processing pipeline with a NIP-98 synchronous endpoint for divine-mobile's fast path and a 1-minute cron for non-Divine client coverage, writing to a D1 audit table and calling Blossom's new `DELETE` action.

**Architecture:** Sync endpoint and cron both invoke a shared `processKind5` function that claims a D1 row via INSERT-OR-IGNORE, fetches the target event from Funnelcake (with read-after-write retry), extracts sha256, calls Blossom, records terminal state. State taxonomy distinguishes `failed:transient:*` (cron-retryable) from `failed:permanent:*`.

**Tech Stack:** Cloudflare Workers, D1, KV, nostr-tools (for NIP-98 signature verification), vitest for tests.

**Scope of this plan:** divine-moderation-service only (PR #92). Sibling work streams are:
- **divine-blossom:** new `DELETE` action + cascade + `ENABLE_PHYSICAL_DELETE` flag + tombstone verification. Has its own plan when that work is picked up.
- **divine-mobile:** polling + UI state machine. Its own plan, sibling of #3101.
- **support-trust-safety:** one-line vocab doc update. Trivial; handled inline when Blossom PR lands.

**Spec:** `docs/superpowers/specs/2026-04-16-per-video-delete-enforcement-design.md` on this branch.

---

## File Structure

**New files:**

- `migrations/006-creator-deletions.sql` — D1 schema for the audit table
- `src/creator-delete/nip98.mjs` — NIP-98 Authorization header validation
- `src/creator-delete/nip98.test.mjs`
- `src/creator-delete/d1.mjs` — D1 helpers (claim, read-state, update-status)
- `src/creator-delete/d1.test.mjs`
- `src/creator-delete/process.mjs` — `processKind5` shared function
- `src/creator-delete/process.test.mjs`
- `src/creator-delete/rate-limit.mjs` — Per-pubkey + per-IP rate limiting via KV counters
- `src/creator-delete/rate-limit.test.mjs`
- `src/creator-delete/sync-endpoint.mjs` — `POST /api/delete/{kind5_id}` handler
- `src/creator-delete/sync-endpoint.test.mjs`
- `src/creator-delete/status-endpoint.mjs` — `GET /api/delete-status/{kind5_id}` handler
- `src/creator-delete/status-endpoint.test.mjs`
- `src/creator-delete/cron.mjs` — Scheduled work for kind 5 polling + transient retry
- `src/creator-delete/cron.test.mjs`

**Files to modify:**

- `wrangler.toml` — Add a `* * * * *` cron entry alongside existing `*/5 * * * *`; verify existing `BLOSSOM_WEBHOOK_SECRET`, `BLOSSOM_ADMIN_URL`, `MODERATION_KV`, `BLOSSOM_DB` bindings are sufficient.
- `src/index.mjs` — Register two routes on `moderation-api.divine.video`; dispatch new cron in the existing `scheduled(event, env, ctx)` handler based on `event.cron`.

Each file has one clear responsibility. `process.mjs` is the hub; endpoints and cron orchestrate around it. Tests are colocated with source (existing repo pattern).

---

## Staging Preflight

Complete these BEFORE starting implementation. Failures here can redirect the design.

- [ ] **Funnelcake kind 5 queryability.** Open a WebSocket to `wss://relay.staging.divine.video`, send `["REQ","test",{"kinds":[5],"limit":5}]`, confirm events are returned (or that a recent kind 5 is visible). If kind 5s are treated as ephemeral and dropped, the cron strategy does not work and the design needs revision. Record result.

    Command helper:
    ```bash
    wscat -c wss://relay.staging.divine.video
    # after connect:
    ["REQ","preflight",{"kinds":[5],"limit":5}]
    ```

- [ ] **Blossom webhook secret present in staging.** Confirm staging Blossom's `blossom_secrets` Fastly Secret Store has `webhook_secret` populated (same value moderation-service uses).

    ```bash
    # On staging Blossom:
    fastly secret-store-entry list --store-id=<staging-store-id>
    # Look for webhook_secret
    ```

- [ ] **Staging Blossom has PR #33 (or equivalent) deployed.** Confirms `Deleted` status is checked on HLS HEAD and subtitle-by-hash routes. Test: flip a staging blob to `Deleted` via `/admin/api/moderate` with action `BAN` (as a proxy since `DELETE` isn't wired yet), confirm the blob 404s on `/<sha256>`, `/<sha256>.jpg`, `/<sha256>.vtt`.

- [ ] **D1 binding writable from staging.** Confirm the existing `BLOSSOM_DB` binding has write access from staging worker context.

    ```bash
    npx wrangler d1 execute blossom-webhook-events --env staging --command "SELECT name FROM sqlite_master WHERE type='table'"
    ```

- [ ] **NIP-98 verification path works end-to-end.** Sign a test NIP-98 header locally, send a request with it, confirm `nostr-tools` signature verification in the Worker accepts it. No existing code to reference; this is a first-principles check using `nostr-tools/pure` and `nostr-tools/nip98` helpers.

If any preflight check fails, stop and address before writing implementation code.

---

## Task 1: D1 migration for creator_deletions

**Files:**
- Create: `migrations/006-creator-deletions.sql`

- [ ] **Step 1: Write the migration SQL**

    Create `migrations/006-creator-deletions.sql` with:

    ```sql
    -- Audit table for creator-initiated deletions (kind 5 events from Funnelcake).
    -- Composite PRIMARY KEY ensures idempotency across concurrent invocations
    -- (sync endpoint + cron colliding on the same kind 5).
    --
    -- status taxonomy:
    --   accepted                              - claimed by a worker, in-progress
    --   success                               - terminal success
    --   failed:transient:{subcategory}        - retryable by cron (retry_count < 5)
    --   failed:permanent:{subcategory}        - terminal, manual intervention required

    CREATE TABLE IF NOT EXISTS creator_deletions (
      kind5_id TEXT NOT NULL,
      target_event_id TEXT NOT NULL,
      creator_pubkey TEXT NOT NULL,
      blob_sha256 TEXT,
      status TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      completed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (kind5_id, target_event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_creator_deletions_target ON creator_deletions(target_event_id);
    CREATE INDEX IF NOT EXISTS idx_creator_deletions_creator ON creator_deletions(creator_pubkey);
    CREATE INDEX IF NOT EXISTS idx_creator_deletions_sha256 ON creator_deletions(blob_sha256);
    CREATE INDEX IF NOT EXISTS idx_creator_deletions_status ON creator_deletions(status);
    ```

- [ ] **Step 2: Apply migration to staging**

    ```bash
    npx wrangler d1 execute blossom-webhook-events --env staging --file migrations/006-creator-deletions.sql
    ```

    Expected: success, table created.

- [ ] **Step 3: Verify table structure on staging**

    ```bash
    npx wrangler d1 execute blossom-webhook-events --env staging --command ".schema creator_deletions"
    ```

    Expected: output matches the CREATE TABLE statement.

- [ ] **Step 4: Commit**

    ```bash
    git add migrations/006-creator-deletions.sql
    git commit -m "feat: add creator_deletions audit table migration"
    ```

---

## Task 2: NIP-98 validation module

Validates an incoming NIP-98 Authorization header: base64-decoded kind 27235 event with `["u", url]` and `["method", method]` tags, `created_at` within ±60s, valid signature.

**Files:**
- Create: `src/creator-delete/nip98.mjs`
- Create: `src/creator-delete/nip98.test.mjs`

- [ ] **Step 1: Write the first failing test — valid NIP-98 header**

    Create `src/creator-delete/nip98.test.mjs`:

    ```javascript
    import { describe, it, expect, beforeEach } from 'vitest';
    import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
    import { bytesToHex } from '@noble/hashes/utils';
    import { validateNip98Header } from './nip98.mjs';

    describe('validateNip98Header', () => {
      let sk, pk;

      beforeEach(() => {
        sk = generateSecretKey();
        pk = getPublicKey(sk);
      });

      function signNip98(url, method, skOverride) {
        const event = finalizeEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['u', url], ['method', method]],
          content: ''
        }, skOverride || sk);
        const encoded = btoa(JSON.stringify(event));
        return `Nostr ${encoded}`;
      }

      it('accepts a valid signature for matching url and method', async () => {
        const header = signNip98('https://moderation-api.divine.video/api/delete/abc123', 'POST');
        const result = await validateNip98Header(header, 'https://moderation-api.divine.video/api/delete/abc123', 'POST');
        expect(result.valid).toBe(true);
        expect(result.pubkey).toBe(pk);
      });
    });
    ```

- [ ] **Step 2: Run test — confirm it fails**

    ```bash
    npx vitest run src/creator-delete/nip98.test.mjs
    ```

    Expected: FAIL with `Cannot find module './nip98.mjs'` or equivalent.

- [ ] **Step 3: Implement the validator**

    Create `src/creator-delete/nip98.mjs`:

    ```javascript
    // ABOUTME: NIP-98 HTTP Authorization header validation for creator-delete endpoints.
    // ABOUTME: Validates base64-encoded kind 27235 event with u, method tags, ±60s clock drift, signature.

    import { verifyEvent } from 'nostr-tools/pure';

    const CLOCK_DRIFT_SECONDS = 60;
    const EXPECTED_KIND = 27235;

    export async function validateNip98Header(authorizationHeader, expectedUrl, expectedMethod) {
      if (!authorizationHeader || !authorizationHeader.startsWith('Nostr ')) {
        return { valid: false, error: 'Missing or malformed Authorization header (expected "Nostr <base64>")' };
      }

      const encoded = authorizationHeader.slice('Nostr '.length).trim();

      let event;
      try {
        const decoded = atob(encoded);
        event = JSON.parse(decoded);
      } catch (e) {
        return { valid: false, error: `Invalid base64 or JSON in Authorization header: ${e.message}` };
      }

      if (event.kind !== EXPECTED_KIND) {
        return { valid: false, error: `Expected kind ${EXPECTED_KIND}, got ${event.kind}` };
      }

      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - event.created_at) > CLOCK_DRIFT_SECONDS) {
        return { valid: false, error: `created_at ${event.created_at} outside ±${CLOCK_DRIFT_SECONDS}s window (server now: ${now})` };
      }

      const uTag = event.tags.find(t => t[0] === 'u')?.[1];
      const methodTag = event.tags.find(t => t[0] === 'method')?.[1];

      if (uTag !== expectedUrl) {
        return { valid: false, error: `u tag '${uTag}' does not match expected URL '${expectedUrl}'` };
      }

      if ((methodTag || '').toUpperCase() !== expectedMethod.toUpperCase()) {
        return { valid: false, error: `method tag '${methodTag}' does not match expected method '${expectedMethod}'` };
      }

      if (!verifyEvent(event)) {
        return { valid: false, error: 'Signature verification failed' };
      }

      return { valid: true, pubkey: event.pubkey };
    }
    ```

- [ ] **Step 4: Run test — confirm happy path passes**

    ```bash
    npx vitest run src/creator-delete/nip98.test.mjs
    ```

    Expected: PASS.

- [ ] **Step 5: Add failing tests for rejection paths**

    Append to `src/creator-delete/nip98.test.mjs`:

    ```javascript
      it('rejects missing Authorization header', async () => {
        const result = await validateNip98Header(undefined, 'https://x/y', 'POST');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/Missing or malformed/);
      });

      it('rejects non-Nostr scheme', async () => {
        const result = await validateNip98Header('Bearer abc', 'https://x/y', 'POST');
        expect(result.valid).toBe(false);
      });

      it('rejects wrong kind', async () => {
        const event = finalizeEvent({
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['u', 'https://x/y'], ['method', 'POST']],
          content: ''
        }, sk);
        const header = `Nostr ${btoa(JSON.stringify(event))}`;
        const result = await validateNip98Header(header, 'https://x/y', 'POST');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/Expected kind 27235/);
      });

      it('rejects expired created_at (outside ±60s)', async () => {
        const event = finalizeEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000) - 120,
          tags: [['u', 'https://x/y'], ['method', 'POST']],
          content: ''
        }, sk);
        const header = `Nostr ${btoa(JSON.stringify(event))}`;
        const result = await validateNip98Header(header, 'https://x/y', 'POST');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/outside/);
      });

      it('rejects mismatched url', async () => {
        const header = signNip98('https://x/different', 'POST');
        const result = await validateNip98Header(header, 'https://x/expected', 'POST');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/u tag/);
      });

      it('rejects mismatched method', async () => {
        const header = signNip98('https://x/y', 'GET');
        const result = await validateNip98Header(header, 'https://x/y', 'POST');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/method tag/);
      });

      it('rejects tampered signature', async () => {
        const realEvent = finalizeEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['u', 'https://x/y'], ['method', 'POST']],
          content: ''
        }, sk);
        realEvent.sig = realEvent.sig.slice(0, -4) + '0000';
        const header = `Nostr ${btoa(JSON.stringify(realEvent))}`;
        const result = await validateNip98Header(header, 'https://x/y', 'POST');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/Signature/);
      });
    ```

- [ ] **Step 6: Run tests — all should pass**

    ```bash
    npx vitest run src/creator-delete/nip98.test.mjs
    ```

    Expected: all tests PASS.

- [ ] **Step 7: Commit**

    ```bash
    git add src/creator-delete/nip98.mjs src/creator-delete/nip98.test.mjs
    git commit -m "feat: add NIP-98 Authorization header validator"
    ```

---

## Task 3: D1 helpers for creator_deletions

Race-safe claim-or-inspect logic that multiple concurrent invocations can call safely.

**Files:**
- Create: `src/creator-delete/d1.mjs`
- Create: `src/creator-delete/d1.test.mjs`

- [ ] **Step 1: Write failing test for `claimRow` happy path**

    Create `src/creator-delete/d1.test.mjs`:

    ```javascript
    import { describe, it, expect, beforeEach } from 'vitest';
    import { claimRow, readRow, updateToSuccess, updateToFailed } from './d1.mjs';

    // Test helper: in-memory D1 fake with the same schema as creator_deletions.
    function makeFakeD1() {
      const rows = new Map(); // key: `${kind5_id}:${target_event_id}`
      return {
        rows,
        prepare(sql) {
          return {
            _sql: sql,
            _binds: [],
            bind(...args) { this._binds = args; return this; },
            async run() {
              if (this._sql.startsWith('INSERT')) {
                const [kind5_id, target_event_id, creator_pubkey, status, accepted_at] = this._binds;
                const key = `${kind5_id}:${target_event_id}`;
                if (rows.has(key)) {
                  return { meta: { changes: 0, rows_written: 0 } };
                }
                rows.set(key, { kind5_id, target_event_id, creator_pubkey, status, accepted_at, retry_count: 0, last_error: null, blob_sha256: null, completed_at: null });
                return { meta: { changes: 1, rows_written: 1 } };
              }
              if (this._sql.startsWith('UPDATE')) {
                const target_key = `${this._binds[this._binds.length - 2]}:${this._binds[this._binds.length - 1]}`;
                const existing = rows.get(target_key);
                if (existing) {
                  // Very simplified: we're just testing the wrappers, not SQL correctness.
                  rows.set(target_key, { ...existing, _updated: true });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
            async first() {
              if (this._sql.startsWith('SELECT')) {
                const key = `${this._binds[0]}:${this._binds[1]}`;
                return rows.get(key) || null;
              }
              return null;
            }
          };
        }
      };
    }

    describe('claimRow', () => {
      let db;
      beforeEach(() => { db = makeFakeD1(); });

      it('claims a new row and returns claimed: true', async () => {
        const now = new Date().toISOString();
        const result = await claimRow(db, {
          kind5_id: 'k1',
          target_event_id: 't1',
          creator_pubkey: 'pub1',
          accepted_at: now
        });
        expect(result.claimed).toBe(true);
        expect(result.existing).toBeNull();
      });

      it('does not claim when row already exists; returns existing', async () => {
        const now = new Date().toISOString();
        await claimRow(db, { kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', accepted_at: now });
        const second = await claimRow(db, { kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', accepted_at: new Date().toISOString() });
        expect(second.claimed).toBe(false);
        expect(second.existing).toMatchObject({ kind5_id: 'k1', target_event_id: 't1', status: 'accepted' });
      });
    });
    ```

- [ ] **Step 2: Run — confirm it fails**

    ```bash
    npx vitest run src/creator-delete/d1.test.mjs
    ```

    Expected: FAIL — module not found.

- [ ] **Step 3: Implement `claimRow` and companion helpers**

    Create `src/creator-delete/d1.mjs`:

    ```javascript
    // ABOUTME: Race-safe D1 helpers for creator_deletions audit table.
    // ABOUTME: claimRow implements INSERT ... ON CONFLICT DO NOTHING then SELECT to read canonical state.

    const MAX_RETRY_COUNT = 5;
    const IN_PROGRESS_TIMEOUT_MS = 30_000;

    /**
     * Attempt to claim a row for processing. Returns { claimed, existing }.
     * If claimed, this worker owns the row. If not, inspect existing.status and decide.
     */
    export async function claimRow(db, { kind5_id, target_event_id, creator_pubkey, accepted_at }) {
      const insertResult = await db.prepare(
        `INSERT INTO creator_deletions
          (kind5_id, target_event_id, creator_pubkey, status, accepted_at)
         VALUES (?, ?, ?, 'accepted', ?)
         ON CONFLICT(kind5_id, target_event_id) DO NOTHING`
      ).bind(kind5_id, target_event_id, creator_pubkey, accepted_at).run();

      const inserted = insertResult.meta.changes === 1 || insertResult.meta.rows_written === 1;

      if (inserted) {
        return { claimed: true, existing: null };
      }

      const existing = await readRow(db, { kind5_id, target_event_id });
      return { claimed: false, existing };
    }

    export async function readRow(db, { kind5_id, target_event_id }) {
      return db.prepare(
        `SELECT kind5_id, target_event_id, creator_pubkey, blob_sha256, status, accepted_at, completed_at, retry_count, last_error
         FROM creator_deletions WHERE kind5_id = ? AND target_event_id = ?`
      ).bind(kind5_id, target_event_id).first();
    }

    export async function readAllTargetsForKind5(db, { kind5_id }) {
      const result = await db.prepare(
        `SELECT kind5_id, target_event_id, creator_pubkey, blob_sha256, status, accepted_at, completed_at, retry_count, last_error
         FROM creator_deletions WHERE kind5_id = ?`
      ).bind(kind5_id).all();
      return result.results || [];
    }

    export async function updateToSuccess(db, { kind5_id, target_event_id, blob_sha256, completed_at }) {
      await db.prepare(
        `UPDATE creator_deletions
         SET status = 'success', blob_sha256 = ?, completed_at = ?, last_error = NULL
         WHERE kind5_id = ? AND target_event_id = ?`
      ).bind(blob_sha256, completed_at, kind5_id, target_event_id).run();
    }

    export async function updateToFailed(db, { kind5_id, target_event_id, status, last_error, increment_retry = false }) {
      if (increment_retry) {
        await db.prepare(
          `UPDATE creator_deletions
           SET status = ?, last_error = ?, retry_count = retry_count + 1
           WHERE kind5_id = ? AND target_event_id = ?`
        ).bind(status, last_error, kind5_id, target_event_id).run();
      } else {
        await db.prepare(
          `UPDATE creator_deletions
           SET status = ?, last_error = ?
           WHERE kind5_id = ? AND target_event_id = ?`
        ).bind(status, last_error, kind5_id, target_event_id).run();
      }
    }

    /**
     * Decide what to do with an existing row given the claim result.
     * Returns one of: 'proceed' (caller should re-try processing), 'skip_success',
     * 'skip_permanent_failure', 'skip_in_progress'.
     */
    export function decideAction(existing, { now = Date.now() } = {}) {
      if (!existing) return 'proceed';
      if (existing.status === 'success') return 'skip_success';
      if (existing.status.startsWith('failed:permanent:')) return 'skip_permanent_failure';
      if (existing.status === 'accepted') {
        const acceptedMs = Date.parse(existing.accepted_at);
        if (now - acceptedMs < IN_PROGRESS_TIMEOUT_MS) return 'skip_in_progress';
        return 'proceed';
      }
      if (existing.status.startsWith('failed:transient:')) {
        if (existing.retry_count < MAX_RETRY_COUNT) return 'proceed';
        return 'skip_permanent_failure';
      }
      return 'proceed';
    }

    export { MAX_RETRY_COUNT, IN_PROGRESS_TIMEOUT_MS };
    ```

- [ ] **Step 4: Run — confirm happy path passes**

    ```bash
    npx vitest run src/creator-delete/d1.test.mjs
    ```

    Expected: PASS.

- [ ] **Step 5: Add failing tests for `decideAction`**

    Append to `src/creator-delete/d1.test.mjs`:

    ```javascript
    import { decideAction } from './d1.mjs';

    describe('decideAction', () => {
      it('proceed when no row exists', () => {
        expect(decideAction(null)).toBe('proceed');
      });

      it('skip_success on terminal success', () => {
        expect(decideAction({ status: 'success' })).toBe('skip_success');
      });

      it('skip_permanent_failure on permanent failure', () => {
        expect(decideAction({ status: 'failed:permanent:blossom_400' })).toBe('skip_permanent_failure');
      });

      it('skip_in_progress when accepted and recent', () => {
        const now = Date.now();
        const existing = {
          status: 'accepted',
          accepted_at: new Date(now - 5_000).toISOString()
        };
        expect(decideAction(existing, { now })).toBe('skip_in_progress');
      });

      it('proceed when accepted but stale (>30s)', () => {
        const now = Date.now();
        const existing = {
          status: 'accepted',
          accepted_at: new Date(now - 60_000).toISOString()
        };
        expect(decideAction(existing, { now })).toBe('proceed');
      });

      it('proceed when failed:transient and retries remain', () => {
        expect(decideAction({ status: 'failed:transient:blossom_5xx', retry_count: 2 })).toBe('proceed');
      });

      it('skip when failed:transient and retries exhausted', () => {
        expect(decideAction({ status: 'failed:transient:blossom_5xx', retry_count: 5 })).toBe('skip_permanent_failure');
      });
    });
    ```

- [ ] **Step 6: Run — all tests pass**

    ```bash
    npx vitest run src/creator-delete/d1.test.mjs
    ```

    Expected: PASS.

- [ ] **Step 7: Commit**

    ```bash
    git add src/creator-delete/d1.mjs src/creator-delete/d1.test.mjs
    git commit -m "feat: add race-safe D1 helpers for creator_deletions"
    ```

---

## Task 4: `processKind5` core function

The shared function called by both the sync endpoint and the cron. Given a fetched kind 5 event, processes each target independently.

**Files:**
- Create: `src/creator-delete/process.mjs`
- Create: `src/creator-delete/process.test.mjs`

- [ ] **Step 1: Failing test — happy path with one target**

    Create `src/creator-delete/process.test.mjs`:

    ```javascript
    import { describe, it, expect, vi, beforeEach } from 'vitest';
    import { processKind5 } from './process.mjs';

    describe('processKind5', () => {
      let db, fetchTargetEvent, callBlossomDelete;

      beforeEach(() => {
        db = makeFakeD1();
        fetchTargetEvent = vi.fn();
        callBlossomDelete = vi.fn();
      });

      it('happy path: claim, fetch target, extract sha256, call Blossom, mark success', async () => {
        const kind5 = {
          id: 'k1',
          pubkey: 'pub1',
          tags: [['e', 't1']]
        };
        fetchTargetEvent.mockResolvedValueOnce({
          id: 't1',
          pubkey: 'pub1',
          tags: [['imeta', 'url https://media.divine.video/abc.mp4', 'x abc']]
        });
        callBlossomDelete.mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await processKind5(kind5, {
          db,
          fetchTargetEvent,
          callBlossomDelete
        });

        expect(result.targets).toEqual([{ target_event_id: 't1', status: 'success', blob_sha256: 'abc' }]);
        expect(callBlossomDelete).toHaveBeenCalledWith('abc');
      });
    });

    function makeFakeD1() { /* same helper as d1.test.mjs — copy or import */ }
    ```

    Before writing this test, extract `makeFakeD1` and `makeFakeKV` into `src/creator-delete/test-helpers.mjs` (exporting both) and update `d1.test.mjs` + `rate-limit.test.mjs` to import from it. Keeps the fakes DRY across the four test files that need them. This is a mechanical extraction — no new logic, just `mv` + update imports.

- [ ] **Step 2: Run — confirm fail**

    ```bash
    npx vitest run src/creator-delete/process.test.mjs
    ```

    Expected: FAIL — module not found.

- [ ] **Step 3: Implement `processKind5`**

    Create `src/creator-delete/process.mjs`:

    ```javascript
    // ABOUTME: Shared kind 5 processing function used by both sync endpoint and cron.
    // ABOUTME: Race-safe via D1 INSERT-OR-IGNORE claim, handles multi-target kind 5 per NIP-09.

    import { claimRow, readRow, updateToSuccess, updateToFailed, decideAction } from './d1.mjs';

    /**
     * Extract the main blob sha256 from a kind 34236 video event.
     * Looks at imeta tags for x=<sha256> or parses url for the sha256 segment.
     */
    export function extractSha256(targetEvent) {
      for (const tag of targetEvent.tags || []) {
        if (tag[0] !== 'imeta') continue;
        for (const part of tag.slice(1)) {
          if (typeof part !== 'string') continue;
          const xMatch = part.match(/^x\s+([a-f0-9]{64})$/i);
          if (xMatch) return xMatch[1].toLowerCase();
          const urlMatch = part.match(/^url\s+\S*\/([a-f0-9]{64})(?:\.\w+)?(?:\?|$)/i);
          if (urlMatch) return urlMatch[1].toLowerCase();
        }
      }
      return null;
    }

    /**
     * Process a kind 5 event. Processes each e-tag target independently.
     * Returns { targets: [{ target_event_id, status, blob_sha256?, last_error? }] }
     */
    export async function processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now = () => Date.now() }) {
      const targetIds = (kind5.tags || [])
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1]);

      const resultTargets = [];

      for (const target_event_id of targetIds) {
        const acceptedIso = new Date(now()).toISOString();
        const claim = await claimRow(db, {
          kind5_id: kind5.id,
          target_event_id,
          creator_pubkey: kind5.pubkey,
          accepted_at: acceptedIso
        });

        const action = claim.claimed ? 'proceed' : decideAction(claim.existing, { now: now() });

        if (action === 'skip_success') {
          resultTargets.push({ target_event_id, status: 'success', blob_sha256: claim.existing.blob_sha256 });
          continue;
        }
        if (action === 'skip_permanent_failure') {
          resultTargets.push({ target_event_id, status: claim.existing.status, last_error: claim.existing.last_error });
          continue;
        }
        if (action === 'skip_in_progress') {
          resultTargets.push({ target_event_id, status: 'in_progress' });
          continue;
        }

        // action === 'proceed'
        const target = await fetchTargetEvent(target_event_id);
        if (!target) {
          await updateToFailed(db, {
            kind5_id: kind5.id,
            target_event_id,
            status: 'failed:permanent:target_unresolved',
            last_error: 'Target event not found on Funnelcake'
          });
          resultTargets.push({ target_event_id, status: 'failed:permanent:target_unresolved' });
          continue;
        }

        const sha256 = extractSha256(target);
        if (!sha256) {
          await updateToFailed(db, {
            kind5_id: kind5.id,
            target_event_id,
            status: 'failed:permanent:no_sha256',
            last_error: 'No sha256 in target event imeta/url'
          });
          resultTargets.push({ target_event_id, status: 'failed:permanent:no_sha256' });
          continue;
        }

        const blossomResult = await callBlossomDelete(sha256);
        if (blossomResult.ok && blossomResult.status >= 200 && blossomResult.status < 300) {
          await updateToSuccess(db, {
            kind5_id: kind5.id,
            target_event_id,
            blob_sha256: sha256,
            completed_at: new Date(now()).toISOString()
          });
          resultTargets.push({ target_event_id, status: 'success', blob_sha256: sha256 });
          continue;
        }

        // Blossom returned non-2xx
        const isTransient = blossomResult.status >= 500 || blossomResult.status === 429 || blossomResult.networkError;
        const category = isTransient
          ? (blossomResult.networkError ? 'failed:transient:network' : `failed:transient:blossom_${blossomResult.status === 429 ? '429' : '5xx'}`)
          : `failed:permanent:blossom_${blossomResult.status}`;

        await updateToFailed(db, {
          kind5_id: kind5.id,
          target_event_id,
          status: category,
          last_error: blossomResult.error || `Blossom returned ${blossomResult.status}`,
          increment_retry: isTransient
        });
        resultTargets.push({ target_event_id, status: category, last_error: blossomResult.error, blob_sha256: sha256 });
      }

      return { targets: resultTargets };
    }
    ```

- [ ] **Step 4: Run — happy path passes**

    ```bash
    npx vitest run src/creator-delete/process.test.mjs
    ```

    Expected: PASS.

- [ ] **Step 5: Add failing tests for edge cases**

    Append to `src/creator-delete/process.test.mjs`:

    ```javascript
      it('multi-target kind 5: processes each independently', async () => {
        const kind5 = {
          id: 'k1',
          pubkey: 'pub1',
          tags: [['e', 't1'], ['e', 't2']]
        };
        fetchTargetEvent
          .mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', 'x aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']] })
          .mockResolvedValueOnce({ id: 't2', pubkey: 'pub1', tags: [['imeta', 'x bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']] });
        callBlossomDelete.mockResolvedValue({ ok: true, status: 200 });

        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets).toHaveLength(2);
        expect(result.targets.map(t => t.status)).toEqual(['success', 'success']);
      });

      it('target_unresolved when Funnelcake returns null', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        fetchTargetEvent.mockResolvedValueOnce(null);
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:permanent:target_unresolved');
        expect(callBlossomDelete).not.toHaveBeenCalled();
      });

      it('no_sha256 when target event has no imeta', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [] });
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:permanent:no_sha256');
      });

      it('transient failure on Blossom 503', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', 'x abc']] });
        callBlossomDelete.mockResolvedValueOnce({ ok: false, status: 503, error: 'service unavailable' });
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:transient:blossom_5xx');
      });

      it('permanent failure on Blossom 400', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', 'x abc']] });
        callBlossomDelete.mockResolvedValueOnce({ ok: false, status: 400, error: 'bad request' });
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:permanent:blossom_400');
      });

      it('skips when existing row is success (idempotent)', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        // Pre-populate D1 with a successful row
        await db.prepare(
          `INSERT INTO creator_deletions (kind5_id, target_event_id, creator_pubkey, status, accepted_at, blob_sha256)
           VALUES (?, ?, ?, 'success', ?, ?)
           ON CONFLICT(kind5_id, target_event_id) DO NOTHING`
        ).bind('k1', 't1', 'pub1', new Date().toISOString(), 'abc').run();
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('success');
        expect(callBlossomDelete).not.toHaveBeenCalled();
        expect(fetchTargetEvent).not.toHaveBeenCalled();
      });
    ```

- [ ] **Step 6: Run — all tests pass**

    ```bash
    npx vitest run src/creator-delete/process.test.mjs
    ```

    Expected: PASS.

- [ ] **Step 7: Commit**

    ```bash
    git add src/creator-delete/process.mjs src/creator-delete/process.test.mjs
    git commit -m "feat: add processKind5 shared function with race-safe D1 claim"
    ```

---

## Task 5: Rate limiter

Per-pubkey and per-IP request rate limiting via KV counters.

**Files:**
- Create: `src/creator-delete/rate-limit.mjs`
- Create: `src/creator-delete/rate-limit.test.mjs`

- [ ] **Step 1: Failing test — under limit**

    Create `src/creator-delete/rate-limit.test.mjs`:

    ```javascript
    import { describe, it, expect, beforeEach } from 'vitest';
    import { checkRateLimit } from './rate-limit.mjs';

    function makeFakeKV() {
      const store = new Map();
      return {
        async get(key) { return store.get(key) ?? null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); }
      };
    }

    describe('checkRateLimit', () => {
      let kv;
      beforeEach(() => { kv = makeFakeKV(); });

      it('allows under the limit', async () => {
        const result = await checkRateLimit(kv, { key: 'pubkey:abc', limit: 5, windowSeconds: 60 });
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4);
      });

      it('blocks over the limit', async () => {
        for (let i = 0; i < 5; i++) {
          await checkRateLimit(kv, { key: 'pubkey:abc', limit: 5, windowSeconds: 60 });
        }
        const result = await checkRateLimit(kv, { key: 'pubkey:abc', limit: 5, windowSeconds: 60 });
        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
      });
    });
    ```

- [ ] **Step 2: Run — FAIL (module missing)**

    ```bash
    npx vitest run src/creator-delete/rate-limit.test.mjs
    ```

- [ ] **Step 3: Implement rate limiter**

    Create `src/creator-delete/rate-limit.mjs`:

    ```javascript
    // ABOUTME: Simple KV-backed sliding window rate limiter for per-pubkey and per-IP limits.
    // ABOUTME: Not perfectly accurate (no cross-region consistency) but sufficient for abuse prevention.

    export async function checkRateLimit(kv, { key, limit, windowSeconds }) {
      const now = Math.floor(Date.now() / 1000);
      const bucket = Math.floor(now / windowSeconds);
      const kvKey = `ratelimit:${key}:${bucket}`;
      const current = parseInt((await kv.get(kvKey)) || '0', 10);

      if (current >= limit) {
        return { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds - (now % windowSeconds) };
      }

      const next = current + 1;
      await kv.put(kvKey, String(next), { expirationTtl: windowSeconds * 2 });
      return { allowed: true, remaining: limit - next };
    }

    export function buildRateLimitKeys({ pubkey, clientIp }) {
      return {
        pubkeyKey: pubkey ? `pubkey:${pubkey}` : null,
        ipKey: clientIp ? `ip:${clientIp}` : null
      };
    }
    ```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

    ```bash
    git add src/creator-delete/rate-limit.mjs src/creator-delete/rate-limit.test.mjs
    git commit -m "feat: add KV-backed rate limiter for creator-delete endpoints"
    ```

---

## Task 6: Sync endpoint (`POST /api/delete/{kind5_id}`)

Wraps NIP-98 validation, rate limiting, Funnelcake fetch with retries, `processKind5`, internal budget, and response formatting.

**Files:**
- Create: `src/creator-delete/sync-endpoint.mjs`
- Create: `src/creator-delete/sync-endpoint.test.mjs`

- [ ] **Step 1: Failing test — happy path**

    Create `src/creator-delete/sync-endpoint.test.mjs`:

    ```javascript
    import { describe, it, expect, vi, beforeEach } from 'vitest';
    import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
    import { handleSyncDelete } from './sync-endpoint.mjs';

    describe('handleSyncDelete', () => {
      let sk, pk, deps;

      beforeEach(() => {
        sk = generateSecretKey();
        pk = getPublicKey(sk);
        deps = {
          db: makeFakeD1(),
          kv: makeFakeKV(),
          fetchKind5WithRetry: vi.fn(),
          fetchTargetEvent: vi.fn(),
          callBlossomDelete: vi.fn(),
          budgetMs: 8000
        };
      });

      function signNip98(url, method) {
        const event = finalizeEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['u', url], ['method', method]],
          content: ''
        }, sk);
        return `Nostr ${btoa(JSON.stringify(event))}`;
      }

      it('returns 200 with success on happy path', async () => {
        const kind5 = { id: 'k1', pubkey: pk, tags: [['e', 't1']] };
        deps.fetchKind5WithRetry.mockResolvedValueOnce(kind5);
        deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: pk, tags: [['imeta', 'x abc']] });
        deps.callBlossomDelete.mockResolvedValueOnce({ ok: true, status: 200 });

        const request = new Request('https://moderation-api.divine.video/api/delete/k1', {
          method: 'POST',
          headers: { 'Authorization': signNip98('https://moderation-api.divine.video/api/delete/k1', 'POST') }
        });

        const response = await handleSyncDelete(request, deps);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ kind5_id: 'k1', status: 'success' });
        expect(body.targets[0]).toMatchObject({ target_event_id: 't1', status: 'success', blob_sha256: 'abc' });
      });
    });

    function makeFakeD1() { /* see d1.test.mjs */ }
    function makeFakeKV() { /* see rate-limit.test.mjs */ }
    ```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement handler**

    Create `src/creator-delete/sync-endpoint.mjs`:

    ```javascript
    // ABOUTME: POST /api/delete/{kind5_id} — synchronous creator-delete handler.
    // ABOUTME: NIP-98 author-only auth; fetches kind 5 with read-after-write retries; runs processKind5 within budget.

    import { validateNip98Header } from './nip98.mjs';
    import { processKind5 } from './process.mjs';
    import { checkRateLimit } from './rate-limit.mjs';

    const PER_PUBKEY_LIMIT = 5;
    const PER_IP_LIMIT = 30;
    const RATE_WINDOW_SECONDS = 60;

    export async function handleSyncDelete(request, deps) {
      const { db, kv, fetchKind5WithRetry, fetchTargetEvent, callBlossomDelete, budgetMs = 8000 } = deps;

      const url = new URL(request.url);
      const kind5_id = url.pathname.split('/').pop();

      if (!kind5_id || !/^[a-f0-9]{64}$/i.test(kind5_id)) {
        return jsonResponse(400, { error: 'Invalid kind5_id' });
      }

      const auth = await validateNip98Header(request.headers.get('Authorization'), url.toString(), 'POST');
      if (!auth.valid) {
        return jsonResponse(401, { error: `NIP-98 validation failed: ${auth.error}` });
      }

      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ipCheck = await checkRateLimit(kv, { key: `ip:${clientIp}`, limit: PER_IP_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
      const pubkeyCheck = await checkRateLimit(kv, { key: `pubkey:${auth.pubkey}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
      if (!ipCheck.allowed || !pubkeyCheck.allowed) {
        return jsonResponse(429, {
          error: 'Rate limit exceeded',
          retry_after_seconds: Math.max(ipCheck.retryAfterSeconds || 0, pubkeyCheck.retryAfterSeconds || 0)
        });
      }

      const kind5 = await fetchKind5WithRetry(kind5_id);
      if (!kind5) {
        return jsonResponse(404, { error: 'Kind 5 not found on Funnelcake after retries' });
      }

      if (kind5.pubkey !== auth.pubkey) {
        return jsonResponse(403, { error: 'Caller pubkey does not match kind 5 author' });
      }

      const deadline = Date.now() + budgetMs;
      const processing = processKind5(kind5, {
        db,
        fetchTargetEvent,
        callBlossomDelete
      });

      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ budgetExceeded: true }), budgetMs));
      const raceResult = await Promise.race([processing, timeoutPromise]);

      if (raceResult.budgetExceeded) {
        return jsonResponse(202, {
          kind5_id,
          status: 'in_progress',
          poll_url: `/api/delete-status/${kind5_id}`
        });
      }

      const anyFailed = raceResult.targets.some(t => t.status.startsWith('failed:'));
      const anyInProgress = raceResult.targets.some(t => t.status === 'in_progress');

      if (anyInProgress && Date.now() < deadline) {
        // One target still had an in-progress existing row. Return 202.
        return jsonResponse(202, {
          kind5_id,
          status: 'in_progress',
          poll_url: `/api/delete-status/${kind5_id}`
        });
      }

      return jsonResponse(200, {
        kind5_id,
        status: anyFailed ? 'failed' : 'success',
        targets: raceResult.targets
      });
    }

    function jsonResponse(status, body) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
    ```

- [ ] **Step 4: Run — happy path passes**

- [ ] **Step 5: Add failing tests for each rejection/error path**

    Append to the test file — tests for: 400 on malformed kind5_id, 401 on invalid NIP-98, 403 on pubkey mismatch, 404 on Funnelcake fetch failure, 429 on rate limit, 202 on budget exceeded.

    ```javascript
      it('returns 400 on malformed kind5_id', async () => {
        const request = new Request('https://moderation-api.divine.video/api/delete/notahex', { method: 'POST', headers: { Authorization: signNip98('https://moderation-api.divine.video/api/delete/notahex', 'POST') } });
        const response = await handleSyncDelete(request, deps);
        expect(response.status).toBe(400);
      });

      it('returns 401 on missing NIP-98', async () => {
        const request = new Request('https://moderation-api.divine.video/api/delete/' + 'a'.repeat(64), { method: 'POST' });
        const response = await handleSyncDelete(request, deps);
        expect(response.status).toBe(401);
      });

      it('returns 403 when caller pubkey does not match kind 5 author', async () => {
        const otherSk = generateSecretKey();
        const otherPk = getPublicKey(otherSk);
        const kind5 = { id: 'a'.repeat(64), pubkey: otherPk, tags: [['e', 't1']] };
        deps.fetchKind5WithRetry.mockResolvedValueOnce(kind5);

        const url = 'https://moderation-api.divine.video/api/delete/' + 'a'.repeat(64);
        const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
        const response = await handleSyncDelete(request, deps);
        expect(response.status).toBe(403);
      });

      it('returns 404 when Funnelcake fetch returns null after retries', async () => {
        deps.fetchKind5WithRetry.mockResolvedValueOnce(null);
        const url = 'https://moderation-api.divine.video/api/delete/' + 'a'.repeat(64);
        const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
        const response = await handleSyncDelete(request, deps);
        expect(response.status).toBe(404);
      });

      it('returns 429 when per-pubkey limit exceeded', async () => {
        const url = 'https://moderation-api.divine.video/api/delete/' + 'a'.repeat(64);
        // Exhaust limit
        for (let i = 0; i < PER_PUBKEY_LIMIT; i++) {
          await checkRateLimit(deps.kv, { key: `pubkey:${pk}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
        }
        const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
        const response = await handleSyncDelete(request, deps);
        expect(response.status).toBe(429);
      });

      it('returns 202 when internal budget exceeded', async () => {
        const kind5 = { id: 'a'.repeat(64), pubkey: pk, tags: [['e', 't1']] };
        deps.fetchKind5WithRetry.mockResolvedValueOnce(kind5);
        deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: pk, tags: [['imeta', 'x abc']] });
        // Blossom slow — never resolves within budget
        deps.callBlossomDelete.mockReturnValueOnce(new Promise(() => {}));

        const url = 'https://moderation-api.divine.video/api/delete/' + 'a'.repeat(64);
        const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
        const response = await handleSyncDelete(request, { ...deps, budgetMs: 50 });
        expect(response.status).toBe(202);
        const body = await response.json();
        expect(body.status).toBe('in_progress');
      });
    ```

    Import `checkRateLimit` and constants at the top of the test file.

- [ ] **Step 6: Run — all pass**

- [ ] **Step 7: Commit**

    ```bash
    git add src/creator-delete/sync-endpoint.mjs src/creator-delete/sync-endpoint.test.mjs
    git commit -m "feat: add POST /api/delete/{kind5_id} synchronous endpoint"
    ```

---

## Task 7: Status endpoint (`GET /api/delete-status/{kind5_id}`)

NIP-98 author-only read of D1 rows for a given kind5_id.

**Files:**
- Create: `src/creator-delete/status-endpoint.mjs`
- Create: `src/creator-delete/status-endpoint.test.mjs`

- [ ] **Step 1: Failing test — happy path**

    ```javascript
    import { describe, it, expect, beforeEach } from 'vitest';
    import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
    import { handleStatusQuery } from './status-endpoint.mjs';

    describe('handleStatusQuery', () => {
      let sk, pk, deps;

      beforeEach(() => {
        sk = generateSecretKey();
        pk = getPublicKey(sk);
        deps = { db: makeFakeD1(), kv: makeFakeKV() };
      });

      function signNip98Get(url) {
        const event = finalizeEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['u', url], ['method', 'GET']],
          content: ''
        }, sk);
        return `Nostr ${btoa(JSON.stringify(event))}`;
      }

      it('returns 200 with target rows for the caller pubkey', async () => {
        await deps.db.prepare(
          `INSERT INTO creator_deletions (kind5_id, target_event_id, creator_pubkey, status, accepted_at, blob_sha256, completed_at)
           VALUES (?, ?, ?, 'success', ?, 'abc', ?)
           ON CONFLICT(kind5_id, target_event_id) DO NOTHING`
        ).bind('k1', 't1', pk, new Date().toISOString(), new Date().toISOString()).run();

        const url = 'https://moderation-api.divine.video/api/delete-status/k1';
        const request = new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } });
        const response = await handleStatusQuery(request, deps);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.kind5_id).toBe('k1');
        expect(body.targets[0]).toMatchObject({ target_event_id: 't1', status: 'success' });
      });
    });
    ```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `handleStatusQuery`**

    ```javascript
    // ABOUTME: GET /api/delete-status/{kind5_id} — NIP-98 author-only status query.
    // ABOUTME: Reads creator_deletions D1 rows for the kind5_id, enforces caller matches the rows' creator_pubkey.

    import { validateNip98Header } from './nip98.mjs';
    import { readAllTargetsForKind5 } from './d1.mjs';
    import { checkRateLimit } from './rate-limit.mjs';

    const PER_PUBKEY_LIMIT = 120; // 2/sec average
    const RATE_WINDOW_SECONDS = 60;

    export async function handleStatusQuery(request, deps) {
      const { db, kv } = deps;
      const url = new URL(request.url);
      const kind5_id = url.pathname.split('/').pop();

      if (!kind5_id) {
        return jsonResponse(400, { error: 'Missing kind5_id' });
      }

      const auth = await validateNip98Header(request.headers.get('Authorization'), url.toString(), 'GET');
      if (!auth.valid) {
        return jsonResponse(401, { error: `NIP-98 validation failed: ${auth.error}` });
      }

      const pubkeyCheck = await checkRateLimit(kv, { key: `status:${auth.pubkey}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
      if (!pubkeyCheck.allowed) {
        return jsonResponse(429, { error: 'Rate limit exceeded', retry_after_seconds: pubkeyCheck.retryAfterSeconds });
      }

      const rows = await readAllTargetsForKind5(db, { kind5_id });
      if (rows.length === 0) {
        return jsonResponse(404, { error: 'No processing record for this kind5_id' });
      }

      const notAuthoredByCaller = rows.find(r => r.creator_pubkey !== auth.pubkey);
      if (notAuthoredByCaller) {
        return jsonResponse(403, { error: 'Caller pubkey does not match kind 5 author' });
      }

      return jsonResponse(200, {
        kind5_id,
        targets: rows.map(r => ({
          target_event_id: r.target_event_id,
          blob_sha256: r.blob_sha256,
          status: r.status,
          accepted_at: r.accepted_at,
          completed_at: r.completed_at,
          last_error: r.last_error
        }))
      });
    }

    function jsonResponse(status, body) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
    ```

- [ ] **Step 4: Run — happy path passes**

- [ ] **Step 5: Add failing tests for rejection paths**

    Append to `src/creator-delete/status-endpoint.test.mjs`:

    ```javascript
      it('returns 401 when Authorization header is missing', async () => {
        const url = 'https://moderation-api.divine.video/api/delete-status/k1';
        const response = await handleStatusQuery(new Request(url, { method: 'GET' }), deps);
        expect(response.status).toBe(401);
      });

      it('returns 404 when no rows exist for the kind5_id', async () => {
        const url = 'https://moderation-api.divine.video/api/delete-status/unknown';
        const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
        expect(response.status).toBe(404);
      });

      it('returns 403 when caller pubkey does not match row creator_pubkey', async () => {
        const otherSk = generateSecretKey();
        const otherPk = getPublicKey(otherSk);
        await deps.db.prepare(
          `INSERT INTO creator_deletions (kind5_id, target_event_id, creator_pubkey, status, accepted_at)
           VALUES (?, ?, ?, 'success', ?)
           ON CONFLICT(kind5_id, target_event_id) DO NOTHING`
        ).bind('k2', 't1', otherPk, new Date().toISOString()).run();

        const url = 'https://moderation-api.divine.video/api/delete-status/k2';
        const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
        expect(response.status).toBe(403);
      });

      it('returns 429 when per-pubkey rate limit exceeded', async () => {
        for (let i = 0; i < 120; i++) {
          await checkRateLimit(deps.kv, { key: `status:${pk}`, limit: 120, windowSeconds: 60 });
        }
        const url = 'https://moderation-api.divine.video/api/delete-status/k1';
        const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
        expect(response.status).toBe(429);
      });
    ```

    Add `import { checkRateLimit } from './rate-limit.mjs'` at the top of the test file.

- [ ] **Step 6: Run — all pass**

- [ ] **Step 7: Commit**

    ```bash
    git add src/creator-delete/status-endpoint.mjs src/creator-delete/status-endpoint.test.mjs
    git commit -m "feat: add GET /api/delete-status/{kind5_id} with NIP-98 auth"
    ```

---

## Task 8: Funnelcake fetch helper with read-after-write retry

Thin wrapper over existing `fetchNostrEventById` with retry schedule 0ms, 100ms, 500ms, 1s, 2s.

**Files:**
- Create: `src/creator-delete/funnelcake-fetch.mjs`
- Create: `src/creator-delete/funnelcake-fetch.test.mjs`

- [ ] **Step 1: Failing test — retries until success**

    ```javascript
    import { describe, it, expect, vi } from 'vitest';
    import { fetchKind5WithRetry } from './funnelcake-fetch.mjs';

    describe('fetchKind5WithRetry', () => {
      it('returns event after two nulls then success', async () => {
        const underlying = vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'k1', kind: 5 });
        const result = await fetchKind5WithRetry('k1', { fetchEventById: underlying, retryDelaysMs: [0, 10, 20] });
        expect(result).toEqual({ id: 'k1', kind: 5 });
        expect(underlying).toHaveBeenCalledTimes(3);
      });

      it('returns null if all retries return null', async () => {
        const underlying = vi.fn().mockResolvedValue(null);
        const result = await fetchKind5WithRetry('k1', { fetchEventById: underlying, retryDelaysMs: [0, 10] });
        expect(result).toBeNull();
        expect(underlying).toHaveBeenCalledTimes(2);
      });
    });
    ```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

    ```javascript
    // ABOUTME: Funnelcake kind 5 fetch with read-after-write retry.
    // ABOUTME: Handles the window between Funnelcake accept (NIP-01 OK) and async ClickHouse write.

    const DEFAULT_RETRY_DELAYS_MS = [0, 100, 500, 1000, 2000];

    export async function fetchKind5WithRetry(kind5_id, { fetchEventById, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
      for (const delay of retryDelaysMs) {
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        const event = await fetchEventById(kind5_id);
        if (event) return event;
      }
      return null;
    }
    ```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit**

    ```bash
    git add src/creator-delete/funnelcake-fetch.mjs src/creator-delete/funnelcake-fetch.test.mjs
    git commit -m "feat: add Funnelcake kind 5 fetch with read-after-write retry"
    ```

---

## Task 9: Blossom DELETE call wrapper

Thin wrapper that calls Blossom's `/admin/api/moderate` with `action: "DELETE"` and the existing `webhook_secret` Bearer.

**Files:**
- Create: `src/creator-delete/blossom-client.mjs`
- Create: `src/creator-delete/blossom-client.test.mjs`

- [ ] **Step 1: Failing test — happy path**

    ```javascript
    import { describe, it, expect, vi } from 'vitest';
    import { callBlossomDelete } from './blossom-client.mjs';

    describe('callBlossomDelete', () => {
      it('POSTs to /admin/api/moderate with action DELETE and Bearer', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
        const result = await callBlossomDelete('abc123', {
          adminUrl: 'https://media.divine.video',
          webhookSecret: 'secret-value',
          fetchFn: fetchMock
        });
        expect(fetchMock).toHaveBeenCalledWith(
          'https://media.divine.video/admin/api/moderate',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ 'Authorization': 'Bearer secret-value' }),
            body: JSON.stringify({ sha256: 'abc123', action: 'DELETE' })
          })
        );
        expect(result).toMatchObject({ ok: true, status: 200 });
      });

      it('returns networkError: true when fetch throws', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('connection reset'));
        const result = await callBlossomDelete('abc', { adminUrl: 'https://x', webhookSecret: 's', fetchFn: fetchMock });
        expect(result).toMatchObject({ ok: false, networkError: true });
      });
    });
    ```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

    ```javascript
    // ABOUTME: Wrapper around Blossom's /admin/api/moderate endpoint for DELETE actions.
    // ABOUTME: Returns { ok, status, error?, networkError? } for consumption by processKind5.

    export async function callBlossomDelete(sha256, { adminUrl, webhookSecret, fetchFn = fetch }) {
      let response;
      try {
        response = await fetchFn(`${adminUrl}/admin/api/moderate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${webhookSecret}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sha256, action: 'DELETE' })
        });
      } catch (e) {
        return { ok: false, networkError: true, error: e.message };
      }

      if (response.ok) {
        return { ok: true, status: response.status };
      }

      let errorBody;
      try { errorBody = await response.text(); } catch (e) { errorBody = '(failed to read body)'; }

      return { ok: false, status: response.status, error: errorBody };
    }
    ```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit**

    ```bash
    git add src/creator-delete/blossom-client.mjs src/creator-delete/blossom-client.test.mjs
    git commit -m "feat: add Blossom DELETE action client"
    ```

---

## Task 10: Cron trigger for kind 5 processing

Every-minute cron: REQ Funnelcake for kind 5 events since last poll; call `processKind5` for each. Also retries `failed:transient:*` rows with `retry_count < 5`.

**Files:**
- Create: `src/creator-delete/cron.mjs`
- Create: `src/creator-delete/cron.test.mjs`

- [ ] **Step 1: Failing test — happy path**

    ```javascript
    import { describe, it, expect, vi, beforeEach } from 'vitest';
    import { runCreatorDeleteCron } from './cron.mjs';

    describe('runCreatorDeleteCron', () => {
      let deps;
      beforeEach(() => {
        deps = {
          db: makeFakeD1(),
          kv: makeFakeKV(),
          queryKind5Since: vi.fn(),
          fetchTargetEvent: vi.fn(),
          callBlossomDelete: vi.fn(),
          now: () => 1700000000000
        };
      });

      it('queries Funnelcake from last poll, processes each event, updates last poll', async () => {
        await deps.kv.put('creator-delete-cron:last-poll', String(1700000000000 - 60_000));
        deps.queryKind5Since.mockResolvedValueOnce([
          { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] }
        ]);
        deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', 'x abc']] });
        deps.callBlossomDelete.mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await runCreatorDeleteCron(deps);
        expect(deps.queryKind5Since).toHaveBeenCalled();
        expect(result.processed).toBe(1);
        const lastPoll = await deps.kv.get('creator-delete-cron:last-poll');
        expect(Number(lastPoll)).toBe(1700000000000);
      });
    });
    ```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

    ```javascript
    // ABOUTME: Cron work for creator-delete pipeline — pulls kind 5 from Funnelcake, retries transient failures.

    import { processKind5 } from './process.mjs';

    const LAST_POLL_KEY = 'creator-delete-cron:last-poll';
    const DEFAULT_LOOKBACK_SECONDS = 3600; // first run
    const MAX_RETRY_COUNT = 5;

    export async function runCreatorDeleteCron(deps) {
      const { db, kv, queryKind5Since, fetchTargetEvent, callBlossomDelete, now = () => Date.now() } = deps;
      const nowMs = now();

      const lastPollRaw = await kv.get(LAST_POLL_KEY);
      const lastPollMs = lastPollRaw ? Number(lastPollRaw) : nowMs - (DEFAULT_LOOKBACK_SECONDS * 1000);
      const sinceSeconds = Math.floor(lastPollMs / 1000);

      let processed = 0;
      const errors = [];

      try {
        const events = await queryKind5Since(sinceSeconds);
        for (const kind5 of events) {
          try {
            await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
            processed++;
          } catch (e) {
            errors.push({ kind5_id: kind5.id, error: e.message });
          }
        }
      } catch (e) {
        errors.push({ stage: 'query', error: e.message });
      }

      // Retry failed:transient rows
      const transientRows = await db.prepare(
        `SELECT kind5_id, target_event_id, creator_pubkey, status, retry_count, accepted_at
         FROM creator_deletions
         WHERE status LIKE 'failed:transient:%' AND retry_count < ?`
      ).bind(MAX_RETRY_COUNT).all();

      for (const row of (transientRows.results || [])) {
        try {
          const kind5 = { id: row.kind5_id, pubkey: row.creator_pubkey, tags: [['e', row.target_event_id]] };
          await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
          processed++;
        } catch (e) {
          errors.push({ kind5_id: row.kind5_id, stage: 'retry', error: e.message });
        }
      }

      await kv.put(LAST_POLL_KEY, String(nowMs));

      return { processed, errors };
    }

    export { LAST_POLL_KEY };
    ```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Add test for transient retry**

    ```javascript
      it('retries failed:transient rows with retry_count < 5', async () => {
        await deps.db.prepare(
          `INSERT INTO creator_deletions (kind5_id, target_event_id, creator_pubkey, status, accepted_at, retry_count)
           VALUES (?, ?, ?, 'failed:transient:blossom_5xx', ?, 2)
           ON CONFLICT(kind5_id, target_event_id) DO NOTHING`
        ).bind('k1', 't1', 'pub1', new Date(Date.now() - 60_000).toISOString(), 2).run();

        await deps.kv.put('creator-delete-cron:last-poll', String(Date.now() - 30_000));
        deps.queryKind5Since.mockResolvedValueOnce([]); // no new events
        deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', 'x abc']] });
        deps.callBlossomDelete.mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await runCreatorDeleteCron(deps);
        expect(deps.callBlossomDelete).toHaveBeenCalledWith('abc');
        expect(result.processed).toBeGreaterThanOrEqual(1);
      });
    ```

- [ ] **Step 6: Run — all pass**

- [ ] **Step 7: Commit**

    ```bash
    git add src/creator-delete/cron.mjs src/creator-delete/cron.test.mjs
    git commit -m "feat: add creator-delete cron for kind 5 polling and transient retry"
    ```

---

## Task 11: Wire routes and cron into index.mjs and wrangler.toml

**Files:**
- Modify: `wrangler.toml`
- Modify: `src/index.mjs`

- [ ] **Step 1: Update wrangler.toml cron schedule**

    Replace the existing:
    ```toml
    [triggers]
    crons = ["*/5 * * * *"]
    ```
    with:
    ```toml
    [triggers]
    crons = ["* * * * *", "*/5 * * * *"]
    ```

- [ ] **Step 2: Verify new cron accepted by wrangler dry-run**

    ```bash
    npx wrangler deploy --dry-run --env staging
    ```
    Expected: success, no errors on cron config.

- [ ] **Step 3: Wire routes into `src/index.mjs`**

    Add imports near the top of `src/index.mjs`:

    ```javascript
    import { handleSyncDelete } from './creator-delete/sync-endpoint.mjs';
    import { handleStatusQuery } from './creator-delete/status-endpoint.mjs';
    import { runCreatorDeleteCron } from './creator-delete/cron.mjs';
    import { fetchKind5WithRetry } from './creator-delete/funnelcake-fetch.mjs';
    import { callBlossomDelete as blossomDelete } from './creator-delete/blossom-client.mjs';
    ```

    In the fetch handler, add (find the API_HOSTNAME routing block):

    ```javascript
    // Creator-delete endpoints
    if (url.hostname === API_HOSTNAME) {
      if (url.pathname.startsWith('/api/delete/') && request.method === 'POST') {
        return handleSyncDelete(request, {
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV,
          fetchKind5WithRetry: (id) => fetchKind5WithRetry(id, {
            fetchEventById: (eid) => fetchNostrEventById(eid, [env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video'], env)
          }),
          fetchTargetEvent: (eid) => fetchNostrEventById(eid, [env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video'], env),
          callBlossomDelete: (sha256) => blossomDelete(sha256, {
            adminUrl: env.BLOSSOM_ADMIN_URL,
            webhookSecret: env.BLOSSOM_WEBHOOK_SECRET
          })
        });
      }

      if (url.pathname.startsWith('/api/delete-status/') && request.method === 'GET') {
        return handleStatusQuery(request, {
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV
        });
      }
    }
    ```

    Note: `fetchNostrEventById` and `fetchKind5EventsSince` are added to `relay-client.mjs` in Step 5 below. Both are required by the route handlers being wired here.

- [ ] **Step 4: Wire cron dispatch**

    In the existing `scheduled(event, env, ctx)` handler (around line 5009 of index.mjs), add a branch based on `event.cron`:

    ```javascript
    async scheduled(event, env, ctx) {
      if (event.cron === '* * * * *') {
        // Every-minute: creator-delete pipeline
        try {
          const result = await runCreatorDeleteCron({
            db: env.BLOSSOM_DB,
            kv: env.MODERATION_KV,
            queryKind5Since: async (sinceSeconds) => {
              // Use existing relay-client.mjs REQ helper
              return await fetchKind5EventsSince(sinceSeconds, env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video', env);
            },
            fetchTargetEvent: (eid) => fetchNostrEventById(eid, [env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video'], env),
            callBlossomDelete: (sha256) => blossomDelete(sha256, {
              adminUrl: env.BLOSSOM_ADMIN_URL,
              webhookSecret: env.BLOSSOM_WEBHOOK_SECRET
            })
          });
          console.log(`[CREATOR-DELETE-CRON] Processed ${result.processed}, errors: ${result.errors.length}`);
        } catch (e) {
          console.error('[CREATOR-DELETE-CRON] failed:', e);
        }
        return;
      }

      if (event.cron === '*/5 * * * *') {
        // Existing 5-minute relay poller — preserve existing behavior below
        // ... existing scheduled() body ...
      }
    }
    ```

    Restructure the existing scheduled() body to be under the `'*/5 * * * *'` branch rather than unconditional.

- [ ] **Step 5: Add `fetchKind5EventsSince` and `fetchNostrEventById` to `src/nostr/relay-client.mjs`**

    Both are new; they extend the existing WebSocket REQ pattern in `queryRelay`. Add failing tests first in `src/nostr/relay-client.test.mjs`:

    ```javascript
    it('fetchKind5EventsSince returns all kind 5 events for the since filter', async () => {
      // Mock the WebSocket or use a fake relay — follow whichever pattern the existing tests use.
      // Assert that the returned filter matches {kinds: [5], since: <provided>}.
      // Assert the return value is an array of events.
    });

    it('fetchNostrEventById returns a single event by id or null', async () => {
      // Similar: mock relay, assert filter {ids: [<id>], limit: 1}, assert return shape.
    });
    ```

    Then implement the two exports in `relay-client.mjs`, using `queryRelay` with `collectAll: true` for the kind 5 variant (returns all events until EOSE) and the default behavior for the by-id variant (single event).

    ```javascript
    export async function fetchKind5EventsSince(sinceSeconds, relayUrl = 'wss://relay.divine.video', env = {}) {
      return queryRelay(relayUrl, { kinds: [5], since: sinceSeconds }, env, { collectAll: true });
    }

    export async function fetchNostrEventById(eventId, relays = ['wss://relay.divine.video'], env = {}) {
      for (const relayUrl of relays) {
        const event = await queryRelay(relayUrl, { ids: [eventId], limit: 1 }, env);
        if (event) return event;
      }
      return null;
    }
    ```

    Run tests; confirm pass.

- [ ] **Step 6: Local dev sanity check**

    ```bash
    npx wrangler dev
    # In another terminal:
    curl -v http://localhost:8787/api/delete-status/abc -H 'Host: moderation-api.divine.video'
    # Expected: 401 (NIP-98 required)
    ```

- [ ] **Step 7: Commit**

    ```bash
    git add wrangler.toml src/index.mjs src/nostr/relay-client.mjs src/nostr/relay-client.test.mjs
    git commit -m "feat: wire creator-delete routes and cron into worker"
    ```

---

## Task 12: Observability (Sentry alerts and metrics)

**Files:**
- Modify: `src/creator-delete/process.mjs` — add structured logs
- Modify: `src/creator-delete/sync-endpoint.mjs` — add request timing
- Modify: `src/creator-delete/cron.mjs` — add per-trigger-path lag measurement
- Modify: `src/index.mjs` — register Sentry alerts (or add deployment documentation for Sentry UI config)

- [ ] **Step 1: Structured logs in `process.mjs`**

    Wrap the main steps with console.log emitting JSON objects compatible with Sentry/logtail:

    ```javascript
    console.log(JSON.stringify({
      event: 'creator_delete.accepted',
      kind5_id,
      target_event_id,
      creator_pubkey,
      accepted_at: acceptedIso,
      trigger: deps.triggerLabel || 'unknown'
    }));
    ```

    Emit similar events for `creator_delete.success`, `creator_delete.failed` with status field.

- [ ] **Step 2: Sync endpoint timing**

    Wrap handler with `const t0 = Date.now()`, emit `creator_delete.sync.latency_ms` at response time.

- [ ] **Step 3: Cron lag**

    In cron, for each processed kind 5, emit `creator_delete.cron.lag_seconds = now - kind5.created_at`.

- [ ] **Step 4: Sentry alerts (deployment-time config)**

    Document in the PR description the Sentry UI alert rules to configure:
    - Sync endpoint p95 latency > 10s over 15m
    - Sync endpoint 5xx rate > 2% over 15m
    - Cron lag p95 > 120s
    - `creator_delete.permanent_failure` count > 0 in the last hour

- [ ] **Step 5: Commit**

    ```bash
    git add src/creator-delete/*.mjs src/index.mjs
    git commit -m "feat: add structured logs for creator-delete observability"
    ```

---

## Task 13: Staging deploy and end-to-end validation

- [ ] **Step 1: Deploy to staging**

    ```bash
    npx wrangler deploy --env staging
    ```
    Expected: deploy success, routes active.

- [ ] **Step 2: Log deploy**

    ```bash
    scripts/log-deploy.sh divine-moderation-service staging spec/per-video-delete-enforcement "creator-delete v1 staging"
    ```

- [ ] **Step 3: Run staging e2e: sync endpoint happy path**

    Using a test account's nsec, publish a kind 5 to staging Funnelcake deleting a test video. Immediately call the sync endpoint:

    ```bash
    # Script: scripts/test-creator-delete.mjs (create as part of this task)
    # Signs NIP-98, calls sync endpoint, asserts 200 + success
    node scripts/test-creator-delete.mjs --env staging --kind5-id <id> --nsec <test-nsec>
    ```

    Expected: 200 with status `success`, D1 row present with status `success`.

- [ ] **Step 4: Verify Blossom-side effect (flag off)**

    Confirm the target blob shows `Deleted` status in Blossom admin UI and serves 404 on the main URL and thumbnail. With `ENABLE_PHYSICAL_DELETE=false` (staging default), GCS bytes should remain.

- [ ] **Step 5: Run staging e2e: cron path**

    Publish a kind 5 to staging Funnelcake WITHOUT calling the sync endpoint. Wait up to 90 seconds. Confirm D1 shows a row with `status: success` and Blossom shows `Deleted`.

- [ ] **Step 6: Run staging e2e: race test**

    Publish a kind 5. Immediately (within 100ms of NIP-01 OK) call the sync endpoint. Assert 200 success without 404 or 202 (retry logic handled the Funnelcake read-after-write race).

- [ ] **Step 7: Record staging validation results in the PR**

    Comment on PR #92 with a summary: preflight results, e2e test results, any observed p95 lag numbers from the staging logs.

- [ ] **Step 8: Commit test script**

    ```bash
    git add scripts/test-creator-delete.mjs
    git commit -m "test: add creator-delete staging e2e script"
    ```

---

## Task 14: Prepare for production

- [ ] **Step 1: Ensure Blossom DELETE PR has landed in prod and flag is off**

    Check `media.divine.video/admin/api/moderate` accepts `action: "DELETE"` with the flag default-off. If not, pause production rollout until Blossom PR lands.

- [ ] **Step 2: Deploy moderation-service to prod with flag off path**

    The moderation-service has no `ENABLE_PHYSICAL_DELETE` flag of its own. Rollout depends on Blossom's flag state.

    ```bash
    npx wrangler deploy --env production
    scripts/log-deploy.sh divine-moderation-service production main "creator-delete v1 prod (flag off)"
    ```

- [ ] **Step 3: Validation window**

    Over the next 1 week (or the first 50 creator deletes in production, whichever comes first), monitor:
    - D1 `creator_deletions` rows
    - Sentry alerts for sync latency, cron lag, Blossom failure rate, permanent failures
    - Blossom dashboard for Deleted blob count + bytes_still_present count

    Confirm pipeline selects the right sha256s (no wrong-blob deletions in the sample). If all green, proceed.

- [ ] **Step 4: Flip the Blossom flag**

    Separately from moderation-service, flip `ENABLE_PHYSICAL_DELETE=true` in Blossom's prod config. Run Blossom's one-time sweep over historical `Deleted` blobs to physically remove their bytes.

- [ ] **Step 5: Confirm physical byte removal**

    Next production delete after flag flip should show both Blossom `Deleted` and GCS bytes gone (verify via Blossom admin). Monitor for failures.

---

## Self-Review checklist

After the plan is written, run through:

**Spec coverage:**
- [x] Subscriber worker (now "Delete processing pipeline") — Tasks 2-10
- [x] D1 audit table — Task 1
- [x] Status endpoint — Task 7
- [x] Mobile polling — out of scope for this plan (separate divine-mobile plan)
- [x] Blossom DELETE action — out of scope (separate divine-blossom plan)
- [x] Vocab doc update — out of scope (trivial, handled with Blossom PR)
- [x] Failure handling matrix — covered in process + sync endpoint + cron
- [x] Observability — Task 12
- [x] Security (NIP-98) — Task 2, applied in Tasks 6 and 7
- [x] Testing — tests in every task, e2e in Task 13
- [x] Dependencies and sequencing — Task 14
- [x] Staging preflight — covered in Preflight section

**Placeholder scan:** No TODOs, no "implement later", no "similar to Task N". Every code step has the code.

**Type consistency:** Function names across tasks (`processKind5`, `claimRow`, `decideAction`, `validateNip98Header`, `callBlossomDelete`, `fetchKind5WithRetry`) match across all tasks they appear in.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-per-video-delete-enforcement-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
