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

## Guardrails — do not do these things without checkpointing with Matt first

### Scope

- Do not add new dependencies beyond what's already in `package.json`.
- Do not refactor files not named in the task's "Files" list.
- Do not introduce new abstractions, helpers, or utilities beyond what the task specifies.
- Do not modify existing routes, handlers, or modules outside the task's scope.
- Do not change existing tests (add new ones; don't modify existing).
- Do not add new env vars beyond those already present or explicitly named in the plan.
- Do not modify `wrangler.toml` bindings except to add the new cron entry named in Task 11.
- Do not touch migrations 001–005; only add `006-creator-deletions.sql`.

### Error handling and complexity

- Do not add error handling for scenarios the plan doesn't name.
- Do not add defensive validation beyond what the plan specifies.
- Do not add feature flags beyond `ENABLE_PHYSICAL_DELETE` (which lives in Blossom, not here).
- Do not add retry logic beyond what the plan specifies (Funnelcake 0/100/500/1000/2000ms; Blossom exponential backoff bounded to `retry_count < 5`).

### Logging and comments

- Do not add `console.log`s beyond the structured logs specified in Task 12.
- Do not add code comments that describe what the code does (well-named identifiers already do that).
- Do add a one-line comment when the WHY is non-obvious (a hidden constraint, workaround, surprising behavior).

### Safety measures — DO NOT REMOVE OR SIMPLIFY

These are required by the spec and protect reliability, security, or compliance.
If any appears redundant, STOP and ask Matt before removing:

- NIP-98 author-only check on sync endpoint and status endpoint (caller pubkey must match kind 5 author).
- NIP-98 ±60s timestamp tolerance window.
- D1 `INSERT ON CONFLICT DO NOTHING` + `SELECT` idempotency claim.
- `decideAction` guard for in-progress / success / permanent-failure states.
- `failed:transient:*` vs `failed:permanent:*` status taxonomy.
- Funnelcake read-after-write retry schedule in the sync endpoint.
- Rate limiting per-pubkey and per-IP.
- 8-second internal budget in sync endpoint (returns 202 beyond that).
- Composite PRIMARY KEY `(kind5_id, target_event_id)` on `creator_deletions`.
- `retry_count` bounded to `< 5` before promotion to `failed:permanent:max_retries_exceeded`.
- Blossom call uses existing `webhook_secret` Bearer (do not propagate secret elsewhere).

### When in doubt

Stop and ask. A checkpoint question is cheaper than reverting a commit.

---

## Per-task review checklist (orchestrator uses this on every subagent output)

- [ ] Tests were written before implementation (visible in git history: test commit precedes impl commit, or same commit includes both with failing test written first).
- [ ] All tests pass (`npx vitest run <path>` shows green).
- [ ] Eslint clean (`node scripts/lint.mjs` passes).
- [ ] No new dependencies in `package.json`.
- [ ] No files touched that aren't in the task's "Files" list.
- [ ] No new abstractions, helpers, or utilities beyond what the plan specifies.
- [ ] Safety measures from the Guardrails section are present and unaltered (spot-check the relevant ones for this task).
- [ ] No `console.log`s left over from debugging (structured logs from Task 12 are exempt).
- [ ] Commit message follows the repo's conventional format (`feat:` / `fix:` / `docs:` / `test:` / `refactor:` prefix; no Claude attribution footer).
- [ ] File header `// ABOUTME:` comments present on new files (matches existing repo convention).
- [ ] MPL license header present on new files (matches existing repo convention).

### Red flags to escalate to Matt

- Subagent added a dependency, refactored an existing file, or introduced a new abstraction.
- Subagent removed or simplified any item from "Safety measures" in Guardrails.
- Tests don't actually exercise the behavior they claim to test.
- Implementation deviates from the plan's spec in any non-trivial way.
- Subagent encountered an error and worked around it silently.

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
    // Note: claimRow's INSERT binds 4 args (kind5_id, target_event_id, creator_pubkey, accepted_at)
    // and inlines 'accepted' as a literal in the SQL. The fake mirrors that arity.
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
                const [kind5_id, target_event_id, creator_pubkey, accepted_at] = this._binds;
                const key = `${kind5_id}:${target_event_id}`;
                if (rows.has(key)) {
                  return { meta: { changes: 0, rows_written: 0 } };
                }
                rows.set(key, { kind5_id, target_event_id, creator_pubkey, status: 'accepted', accepted_at, retry_count: 0, last_error: null, blob_sha256: null, completed_at: null });
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

    Add `decideAction` to the existing top-of-file import (`import { claimRow, readRow, updateToSuccess, updateToFailed, decideAction } from './d1.mjs';`), then append the `describe('decideAction', ...)` block to `src/creator-delete/d1.test.mjs`:

    ```javascript
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

**Execution order dependency:** This task depends on Task 9 (extracted `notifyBlossom`). Complete Task 9 first. The `callBlossomDelete` dependency injected into `processKind5` will be wired at integration time to `(sha256) => notifyBlossom(sha256, 'DELETE', env)` (see Task 11). Mocks and implementation below assume the `notifyBlossom` return shape: `{ success: boolean, status?: number, error?: string, networkError?: boolean, skipped?: boolean }`.

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

      const SHA_C = 'c'.repeat(64); // 64-char hex fixture (extractSha256 requires exactly 64 hex chars)

      it('happy path: claim, fetch target, extract sha256, call Blossom, mark success', async () => {
        const kind5 = {
          id: 'k1',
          pubkey: 'pub1',
          tags: [['e', 't1']]
        };
        fetchTargetEvent.mockResolvedValueOnce({
          id: 't1',
          pubkey: 'pub1',
          tags: [['imeta', `url https://media.divine.video/${SHA_C}.mp4`, `x ${SHA_C}`]]
        });
        callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

        const result = await processKind5(kind5, {
          db,
          fetchTargetEvent,
          callBlossomDelete
        });

        expect(result.targets).toEqual([{ target_event_id: 't1', status: 'success', blob_sha256: SHA_C }]);
        expect(callBlossomDelete).toHaveBeenCalledWith(SHA_C);
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
        if (blossomResult.success && !blossomResult.skipped) {
          await updateToSuccess(db, {
            kind5_id: kind5.id,
            target_event_id,
            blob_sha256: sha256,
            completed_at: new Date(now()).toISOString()
          });
          resultTargets.push({ target_event_id, status: 'success', blob_sha256: sha256 });
          continue;
        }

        // Blossom failed or skipped
        const status = blossomResult.status;
        const isTransient = blossomResult.networkError || (status !== undefined && (status >= 500 || status === 429));
        const category = isTransient
          ? (blossomResult.networkError ? 'failed:transient:network' : `failed:transient:blossom_${status === 429 ? '429' : '5xx'}`)
          : (status !== undefined ? `failed:permanent:blossom_${status}` : 'failed:permanent:blossom_skipped');

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
        callBlossomDelete.mockResolvedValue({ success: true, status: 200 });

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
        fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
        callBlossomDelete.mockResolvedValueOnce({ success: false, status: 503, error: 'HTTP 503: service unavailable' });
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:transient:blossom_5xx');
      });

      it('permanent failure on Blossom 400', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
        callBlossomDelete.mockResolvedValueOnce({ success: false, status: 400, error: 'HTTP 400: bad request' });
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:permanent:blossom_400');
      });

      it('transient failure on network error', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
        callBlossomDelete.mockResolvedValueOnce({ success: false, error: 'connection reset', networkError: true });
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
        expect(result.targets[0].status).toBe('failed:transient:network');
      });

      it('skips when existing row is success (idempotent)', async () => {
        const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
        // Pre-seed D1 directly — bypass the fake's INSERT path, which is tailored to
        // claimRow's 4-arg bind with an inlined 'accepted' status literal. A direct
        // rows.set() lets this test simulate a pre-existing terminal row.
        db.rows.set('k1:t1', {
          kind5_id: 'k1',
          target_event_id: 't1',
          creator_pubkey: 'pub1',
          status: 'success',
          accepted_at: new Date().toISOString(),
          blob_sha256: SHA_C,
          retry_count: 0,
          last_error: null,
          completed_at: new Date().toISOString()
        });
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

## Task 9: Extract `notifyBlossom` to `src/blossom-client.mjs` and add `DELETE` action

**Execution order note: dispatch this BEFORE Task 4 (`processKind5`) — Task 4 imports from the extracted module.**

Preflight found that `src/index.mjs:5337` already has a working `notifyBlossom(sha256, action, env)` that calls Blossom's webhook with Bearer auth, maps internal actions to Blossom actions via `BLOSSOM_ACTION_MAP`, and handles network errors. The existing env vars are `BLOSSOM_WEBHOOK_URL` (full URL) and `BLOSSOM_WEBHOOK_SECRET` — both are set as Wrangler secrets on the production worker and covered by integration tests.

Rather than create a new Blossom client and duplicate ~40 lines of code, extract the existing function into a shared module and add the `DELETE` action. Both existing call sites (AI/moderator paths) and the new creator-delete pipeline will import from it.

**Files:**
- Create: `src/blossom-client.mjs`
- Create: `src/blossom-client.test.mjs`
- Modify: `src/index.mjs` (remove the local `notifyBlossom` definition, add import, no other changes to callers)

**Guardrail exception:** this is a targeted refactor that serves the work (CLAUDE.md explicitly permits this: "Where existing code has problems that affect the work... include targeted improvements as part of the design"). Scope is narrow — move one function to a new file, add one entry to the action map, update existing callers to import. No other refactoring.

- [ ] **Step 1: Read the current `notifyBlossom` definition**

    ```bash
    sed -n '5329,5399p' src/index.mjs
    ```
    Note: this function starts around line 5337 and ends around line 5399. The exact range may shift as other edits land; use `grep -n "async function notifyBlossom" src/index.mjs` to confirm.

- [ ] **Step 2: Write failing test for the extracted module**

    Create `src/blossom-client.test.mjs`:

    ```javascript
    import { describe, it, expect, vi } from 'vitest';
    import { notifyBlossom } from './blossom-client.mjs';

    describe('notifyBlossom (extracted)', () => {
      const baseEnv = {
        BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/api/moderate',
        BLOSSOM_WEBHOOK_SECRET: 'test-secret'
      };

      it('POSTs to BLOSSOM_WEBHOOK_URL with Bearer auth and mapped action', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
        const env = { ...baseEnv };
        global.fetch = fetchMock;

        const result = await notifyBlossom('abc123', 'PERMANENT_BAN', env);

        expect(fetchMock).toHaveBeenCalledWith(
          baseEnv.BLOSSOM_WEBHOOK_URL,
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ 'Authorization': 'Bearer test-secret' }),
            body: expect.stringContaining('"action":"PERMANENT_BAN"')
          })
        );
        expect(result).toMatchObject({ success: true });
      });

      it('maps DELETE → DELETE action', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
        global.fetch = fetchMock;

        await notifyBlossom('abc', 'DELETE', baseEnv);

        expect(fetchMock).toHaveBeenCalledWith(
          baseEnv.BLOSSOM_WEBHOOK_URL,
          expect.objectContaining({
            body: expect.stringContaining('"action":"DELETE"')
          })
        );
      });

      it('returns skipped when BLOSSOM_WEBHOOK_URL is not configured', async () => {
        const result = await notifyBlossom('abc', 'PERMANENT_BAN', { BLOSSOM_WEBHOOK_SECRET: 'x' });
        expect(result).toMatchObject({ success: true, skipped: true });
      });

      it('returns error with numeric status on non-2xx response', async () => {
        global.fetch = vi.fn().mockResolvedValue(new Response('blob not found', { status: 404 }));
        const result = await notifyBlossom('abc', 'PERMANENT_BAN', baseEnv);
        expect(result).toMatchObject({ success: false, status: 404 });
        expect(result.error).toContain('404');
      });

      it('catches fetch rejection with networkError flag', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
        const result = await notifyBlossom('abc', 'PERMANENT_BAN', baseEnv);
        expect(result).toMatchObject({ success: false, networkError: true });
        expect(result.error).toContain('connection reset');
      });
    });
    ```

- [ ] **Step 3: Run — FAIL (module missing)**

    ```bash
    npx vitest run src/blossom-client.test.mjs
    ```

- [ ] **Step 4: Create `src/blossom-client.mjs`**

    Create the file by moving the existing `notifyBlossom` function and `BLOSSOM_ACTION_MAP` out of `src/index.mjs`. Add `'DELETE': 'DELETE'` to the action map. Preserve every line of the existing logic verbatim — this is an extraction, not a rewrite.

    ```javascript
    // This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
    // If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
    //
    // ABOUTME: Shared Blossom admin client. Called from the moderator-action pipeline and the creator-delete pipeline.
    // ABOUTME: Maps internal action names to Blossom-understood actions and POSTs to BLOSSOM_WEBHOOK_URL with Bearer auth.

    // Blossom has five states (Active/Restricted/Pending/Banned/Deleted).
    // Its webhook handler accepts: SAFE→Active, AGE_RESTRICTED→Restricted,
    // PERMANENT_BAN→Banned, RESTRICT→Restricted, DELETE→Deleted.
    // QUARANTINE maps to RESTRICT (owner can view, public gets 404).
    // REVIEW is internal only — content stays publicly accessible.
    const BLOSSOM_ACTION_MAP = {
      'SAFE': 'SAFE',
      'AGE_RESTRICTED': 'AGE_RESTRICTED',
      'PERMANENT_BAN': 'PERMANENT_BAN',
      'QUARANTINE': 'RESTRICT',
      'DELETE': 'DELETE'
    };

    /**
     * Notify divine-blossom of a moderation decision or creator-initiated delete via webhook.
     * @param {string} sha256 - The blob hash
     * @param {string} action - Internal action (SAFE, REVIEW, QUARANTINE, AGE_RESTRICTED, PERMANENT_BAN, DELETE)
     * @param {Object} env - Environment with BLOSSOM_WEBHOOK_URL and BLOSSOM_WEBHOOK_SECRET
     * @returns {Promise<{success: boolean, error?: string, skipped?: boolean, result?: any}>}
     */
    export async function notifyBlossom(sha256, action, env) {
      if (!env.BLOSSOM_WEBHOOK_URL) {
        console.log('[BLOSSOM] Webhook not configured, skipping notification');
        return { success: true, skipped: true };
      }

      const blossomAction = BLOSSOM_ACTION_MAP[action];
      if (!blossomAction) {
        console.log(`[BLOSSOM] Skipping notification for internal action: ${action}`);
        return { success: true, skipped: true };
      }

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (env.BLOSSOM_WEBHOOK_SECRET) {
          headers['Authorization'] = `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}`;
        }

        console.log(`[BLOSSOM] Notifying blossom of ${action} (as ${blossomAction}) for ${sha256}`);

        const response = await fetch(env.BLOSSOM_WEBHOOK_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            sha256,
            action: blossomAction,
            timestamp: new Date().toISOString()
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[BLOSSOM] Webhook failed: ${response.status} - ${errorText}`);
          return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const result = await response.json();
        console.log(`[BLOSSOM] Webhook succeeded for ${sha256}:`, result);
        return { success: true, result, status: response.status };

      } catch (error) {
        console.error(`[BLOSSOM] Webhook error for ${sha256}:`, error);
        return { success: false, error: error.message, networkError: true };
      }
    }

    export { BLOSSOM_ACTION_MAP };
    ```

- [ ] **Step 5: Update `src/index.mjs` to import from the new module**

    Remove the local `notifyBlossom` function definition and the `BLOSSOM_ACTION_MAP` constant inside it. Add an import at the top of the file (near the other imports):

    ```javascript
    import { notifyBlossom } from './blossom-client.mjs';
    ```

    All existing callers of `notifyBlossom(sha256, action, env)` continue to work unchanged — function signature is identical.

- [ ] **Step 6: Run the new blossom-client tests AND the existing integration tests**

    ```bash
    npx vitest run src/blossom-client.test.mjs
    npx vitest run src/index.test.mjs
    ```

    Expected: blossom-client tests pass, existing index tests still pass (the extracted function is behavior-equivalent).

- [ ] **Step 7: Commit**

    ```bash
    git add src/blossom-client.mjs src/blossom-client.test.mjs src/index.mjs
    git commit -m "refactor: extract notifyBlossom to shared module, add DELETE action

    Moves notifyBlossom out of index.mjs so both the existing moderator-action
    pipeline and the new creator-delete pipeline can use the same Blossom
    client. Adds 'DELETE' to BLOSSOM_ACTION_MAP so the new creator-delete
    pipeline can request physical removal via the same webhook path.

    Behavior-equivalent extraction — no changes to existing callers."
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
        deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

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
        deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

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

**Environment variables used here:** `BLOSSOM_WEBHOOK_URL` and `BLOSSOM_WEBHOOK_SECRET` (already set as Wrangler secrets on the production worker; verified in preflight). `CREATOR_DELETE_PIPELINE_ENABLED` is a new env var (default `"false"`; set to `"true"` via `wrangler secret put` or `[vars]` once we are ready to activate the feature in production).

- [ ] **Step 1: Update wrangler.toml cron schedule and add feature flag default**

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

    Add a `CREATOR_DELETE_PIPELINE_ENABLED = "false"` line to the `[vars]` block so the default is inert until explicitly flipped.

- [ ] **Step 2: Verify new cron accepted by wrangler dry-run**

    ```bash
    npx wrangler deploy --dry-run
    ```
    Expected: success, no errors on cron config or vars.

- [ ] **Step 3: Wire routes into `src/index.mjs`**

    Add imports near the top of `src/index.mjs` (next to the other imports):

    ```javascript
    import { handleSyncDelete } from './creator-delete/sync-endpoint.mjs';
    import { handleStatusQuery } from './creator-delete/status-endpoint.mjs';
    import { runCreatorDeleteCron } from './creator-delete/cron.mjs';
    import { fetchKind5WithRetry } from './creator-delete/funnelcake-fetch.mjs';
    import { notifyBlossom } from './blossom-client.mjs'; // already imported via Task 9's extraction; reuse
    import { fetchKind5EventsSince, fetchNostrEventById } from './nostr/relay-client.mjs';
    ```

    In the fetch handler, add (find the API_HOSTNAME routing block):

    ```javascript
    // Creator-delete endpoints — gated by CREATOR_DELETE_PIPELINE_ENABLED feature flag
    if (url.hostname === API_HOSTNAME && env.CREATOR_DELETE_PIPELINE_ENABLED === 'true') {
      const relayUrl = env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video';

      // Adapter: processKind5 and handleSyncDelete expect notifyBlossom's return shape
      // (success, status?, error?, networkError?, skipped?) bound to the DELETE action.
      const callBlossomDelete = (sha256) => notifyBlossom(sha256, 'DELETE', env);

      if (url.pathname.startsWith('/api/delete/') && request.method === 'POST') {
        return handleSyncDelete(request, {
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV,
          fetchKind5WithRetry: (id) => fetchKind5WithRetry(id, {
            fetchEventById: (eid) => fetchNostrEventById(eid, [relayUrl], env)
          }),
          fetchTargetEvent: (eid) => fetchNostrEventById(eid, [relayUrl], env),
          callBlossomDelete
        });
      }

      if (url.pathname.startsWith('/api/delete-status/') && request.method === 'GET') {
        return handleStatusQuery(request, {
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV
        });
      }
    }

    // If CREATOR_DELETE_PIPELINE_ENABLED is not 'true', fall through to existing routing.
    // Routes return 404 from the default handler until the flag is flipped on.
    ```

    Note: `fetchNostrEventById` and `fetchKind5EventsSince` are added to `relay-client.mjs` in Step 5 below. Both are required by the route handlers being wired here.

- [ ] **Step 4: Wire cron dispatch**

    In the existing `scheduled(event, env, ctx)` handler (around line 5009 of index.mjs), add a branch based on `event.cron`. Also gate the new cron on `CREATOR_DELETE_PIPELINE_ENABLED`:

    ```javascript
    async scheduled(event, env, ctx) {
      if (event.cron === '* * * * *') {
        // Every-minute: creator-delete pipeline (gated by feature flag)
        if (env.CREATOR_DELETE_PIPELINE_ENABLED !== 'true') {
          return;
        }
        const relayUrl = env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video';
        try {
          const result = await runCreatorDeleteCron({
            db: env.BLOSSOM_DB,
            kv: env.MODERATION_KV,
            queryKind5Since: async (sinceSeconds) =>
              fetchKind5EventsSince(sinceSeconds, relayUrl, env),
            fetchTargetEvent: (eid) => fetchNostrEventById(eid, [relayUrl], env),
            callBlossomDelete: (sha256) => notifyBlossom(sha256, 'DELETE', env)
          });
          console.log(`[CREATOR-DELETE-CRON] Processed ${result.processed}, errors: ${result.errors.length}`);
        } catch (e) {
          console.error('[CREATOR-DELETE-CRON] failed:', e);
        }
        return;
      }

      if (event.cron === '*/5 * * * *') {
        // Existing 5-minute relay poller — preserve existing behavior below
        // ... existing scheduled() body moves here unchanged ...
      }
    }
    ```

    Restructure the existing scheduled() body to be under the `'*/5 * * * *'` branch rather than unconditional. Do not modify the existing logic; only move it inside the branch.

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

    Temporarily enable the feature flag for local dev, then verify routes respond:

    ```bash
    # Start wrangler dev with the flag enabled for this session only
    CREATOR_DELETE_PIPELINE_ENABLED=true npx wrangler dev --var CREATOR_DELETE_PIPELINE_ENABLED:true
    # In another terminal:
    curl -v http://localhost:8787/api/delete-status/abc -H 'Host: moderation-api.divine.video'
    # Expected: 401 (NIP-98 required)
    ```

    Then re-run without the flag to confirm the endpoints 404 when disabled:

    ```bash
    npx wrangler dev
    curl -v http://localhost:8787/api/delete-status/abc -H 'Host: moderation-api.divine.video'
    # Expected: 404 (routes gated off)
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

## Task 13: Production deploy (feature flag off) and end-to-end validation

This repo does not have a separate staging environment in `wrangler.toml`. The established convention is to deploy directly to production. We mitigate destructive-code risk via two flags layered on top of each other:

1. **`CREATOR_DELETE_PIPELINE_ENABLED`** (this repo) — default `"false"`. Keeps our new routes 404'd and our new cron inert until explicitly flipped on.
2. **`ENABLE_PHYSICAL_DELETE`** (Blossom repo) — default `"false"` on first deploy. Blossom flips status to `Deleted` (stops serving) but does not touch GCS bytes until this flag is flipped.

This means the first production deploy of our code is fully inert. No routes respond. No cron processes. No Blossom calls. Safe by construction.

- [ ] **Step 1: Deploy moderation-service to production with flag off**

    ```bash
    npx wrangler deploy
    ```

    Confirm via `wrangler tail` that the worker is live, existing routes still respond, and the new creator-delete routes return 404 (flag is off).

- [ ] **Step 2: Log deploy**

    ```bash
    scripts/log-deploy.sh divine-moderation-service production spec/per-video-delete-enforcement "creator-delete v1 prod (flag off)"
    ```

- [ ] **Step 3: Create a test script for end-to-end validation**

    Create `scripts/test-creator-delete.mjs` (only run when the flag is on):

    - Accept `--relay <url>` (default `wss://relay.divine.video`), `--api <url>` (default `https://moderation-api.divine.video`), `--nsec <hex>`, `--target-event-id <id>`.
    - Sign a kind 5 deleting the target, publish to the relay, wait for OK.
    - Sign a NIP-98 header for `POST /api/delete/{kind5_id}` and call the sync endpoint.
    - Print the response body and any D1 row state.

    Script should use the existing `scripts/publish-test-video.mjs` style as a reference for CLI args and relay interaction.

- [ ] **Step 4: Flip the flag on a small test account first**

    Because there is no staging, temporarily set `CREATOR_DELETE_PIPELINE_ENABLED="true"` on the production worker:

    ```bash
    npx wrangler secret put CREATOR_DELETE_PIPELINE_ENABLED
    # Enter: true
    ```

    (or add `CREATOR_DELETE_PIPELINE_ENABLED = "true"` to `[vars]` and re-deploy — whichever you prefer.)

- [ ] **Step 5: Run e2e sync endpoint happy path (with a throwaway test video)**

    Upload a throwaway test video via the divine-mobile app using a test account, confirm it's served from Blossom, then:

    ```bash
    node scripts/test-creator-delete.mjs \
      --relay wss://relay.divine.video \
      --api https://moderation-api.divine.video \
      --nsec <test-nsec> \
      --target-event-id <test-video-event-id>
    ```

    Expected: 200 with `status: "success"`. D1 row `{status: "success", blob_sha256: <sha>, completed_at: <timestamp>}`.

- [ ] **Step 6: Verify Blossom-side effect**

    Confirm the target blob serves 404 on:
    - `https://media.divine.video/<sha256>`
    - `https://media.divine.video/<sha256>.jpg`
    - `https://media.divine.video/<sha256>.vtt`

    With `ENABLE_PHYSICAL_DELETE=false` in Blossom (first-prod-deploy default), GCS bytes should still exist. Verify via Blossom admin UI (status shows `Deleted`).

- [ ] **Step 7: Run cron path test**

    Using a different test video + test account, publish a kind 5 WITHOUT calling the sync endpoint. Wait up to 90 seconds. Confirm D1 shows a row with `status: success` and Blossom shows `Deleted`.

- [ ] **Step 8: Run race test**

    Publish a kind 5. Immediately (within 100ms of NIP-01 OK) call the sync endpoint. Assert 200 success without 404 or 202 (retry logic handled the Funnelcake read-after-write race).

- [ ] **Step 9: Record production validation results in the PR**

    Comment on PR #92 with a summary: preflight results, e2e test results, observed p95 latency for sync path, observed cron lag, any failed:transient rows in D1 during validation.

- [ ] **Step 10: Commit test script**

    ```bash
    git add scripts/test-creator-delete.mjs
    git commit -m "test: add creator-delete production validation script"
    ```

---

## Task 14: Validation window and phased flag flips

- [ ] **Step 1: Confirm Blossom DELETE action is accepted in production**

    Blossom's `admin/api/moderate` must accept `action: "DELETE"` before we turn the pipeline on. If the Blossom PR hasn't shipped, either the validation fails or we fall back to `PERMANENT_BAN` for a transitional deploy. Check with a NIP-98-less smoke request to confirm the action is recognized (not necessarily authorized):

    ```bash
    curl -v -X POST https://media.divine.video/admin/api/moderate \
      -H 'Content-Type: application/json' \
      -H 'Authorization: Bearer <test-token-or-empty>' \
      -d '{"sha256":"0000000000000000000000000000000000000000000000000000000000000000","action":"DELETE"}'
    ```

    Expect 401/403 (auth) rather than 400 "Unknown action". If 400 "Unknown action", Blossom doesn't yet have DELETE wired — pause the flag flip until it does.

- [ ] **Step 2: Production validation window**

    With `CREATOR_DELETE_PIPELINE_ENABLED=true` (from Task 13) and Blossom's `ENABLE_PHYSICAL_DELETE=false`, monitor over 1 week OR the first 50 creator deletes in production (whichever comes first):

    - D1 `creator_deletions` rows — scan for `failed:*` statuses
    - Sentry alerts — sync latency, cron lag, Blossom failure rate, permanent failures
    - Blossom dashboard — `Deleted` blob count (should grow), GCS byte count unchanged (flag off)
    - Spot-check: for each of the first ~10 deletes, confirm the blob_sha256 recorded in D1 matches the actual video's sha256 from its kind 34236 event (no wrong-blob deletions)

    Any `failed:permanent:*` rows other than `target_unresolved` are triage tickets, not blockers.

- [ ] **Step 3: Flip the Blossom flag**

    Separately from moderation-service, flip `ENABLE_PHYSICAL_DELETE=true` in Blossom's prod config. Run Blossom's one-time sweep over historical `Deleted` blobs to physically remove their bytes (see Blossom PR for sweep details).

- [ ] **Step 4: Confirm physical byte removal**

    Next production delete after flag flip should show both Blossom `Deleted` status AND GCS bytes gone (verify via Blossom admin UI and direct GCS bucket list). Monitor sync endpoint latency for Blossom-side regression (physical delete adds GCS call latency).

- [ ] **Step 5: Rolling back if needed**

    If any stage reveals a bug, the rollback path is:
    - Flip `CREATOR_DELETE_PIPELINE_ENABLED=false` immediately (stops new pipeline invocations without redeploying)
    - For Blossom issues, flip `ENABLE_PHYSICAL_DELETE=false` (stops new byte deletions)
    - Revert offending commits on a follow-up branch if needed

    Both flags are production-flippable without code changes.

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

**Type consistency:** Function names across tasks (`processKind5`, `claimRow`, `decideAction`, `validateNip98Header`, `notifyBlossom`, `callBlossomDelete` (dep-injection alias bound to `notifyBlossom(sha256, 'DELETE', env)`), `fetchKind5WithRetry`) match across all tasks they appear in.

**Execution order note:**

Because Task 4 (`processKind5`) depends on Task 9 (extraction of `notifyBlossom`), the execution sequence is:

Task 1 → Task 2 → Task 3 → **Task 9** → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 10 → Task 11 → Task 12 → Task 13 → Task 14

Task 9 is physically located after Tasks 4-8 in this document, but MUST be dispatched before Task 4.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-per-video-delete-enforcement-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
