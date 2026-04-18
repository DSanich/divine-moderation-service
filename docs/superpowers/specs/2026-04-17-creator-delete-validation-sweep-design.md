# Creator-delete validation-window physical-delete sweep — design

**Date:** 2026-04-17
**Issue:** [divine-blossom#90](https://github.com/divinevideo/divine-blossom/issues/90)
**Repo:** divine-moderation-service (sweep script + D1 migration)
**Status:** Design approved, pending implementation plan

## Context

PR #92 (per-video delete end-to-end enforcement) shipped behind `CREATOR_DELETE_PIPELINE_ENABLED` and uses Blossom's `DELETE` action gated by `ENABLE_PHYSICAL_DELETE`. The rollout plan intentionally keeps `ENABLE_PHYSICAL_DELETE=false` during the validation window so soft-delete is verified before bytes are destroyed.

During that window, creator-initiated deletions:

- write a `creator_deletions` row in mod-service D1 with `status='success'`,
- cause Blossom to flip the blob's status to `Deleted` (content stops serving),
- **leave the underlying GCS bytes in place** because the flag is off.

The sweep retroactively destroys those bytes once the flag is flipped on, fulfilling the creator's original delete intent.

## Goals

- Identify every creator-delete from the validation window whose bytes were not destroyed.
- Destroy those bytes via Blossom's existing `handle_creator_delete` helper.
- Track per-row completion in D1 so re-runs are O(unfinished) and idempotent.
- Make every creator-intent we cannot fulfill loud and visible — not silently skipped.
- Operator-paced, easy to dry-run, easy to interrupt.

## Non-goals

- Not a permanent worker surface. The sweep is a one-time operation per validation window.
- Not a replacement for the live creator-delete pipeline. New deletes flow through the existing sync endpoint and cron.
- No cron / scheduled execution. The script is run by hand by an operator.
- No retry of `failed:permanent:*` rows. Those failed for a reason; the sweep surfaces them for manual investigation.

## Architecture

```
operator laptop
   │
   └─ scripts/sweep-creator-deletes.mjs
        │
        ├─ wrangler d1 execute  →  divine-moderation-decisions-prod
        │     SELECT candidate rows from creator_deletions
        │
        ├─ for each batch (concurrency=N):
        │     POST https://media.divine.video/admin/moderate
        │         Bearer ${BLOSSOM_WEBHOOK_SECRET}
        │         {sha256, action: "DELETE"}
        │     →  blossom (Fastly Compute)
        │           handle_creator_delete:
        │             - soft_delete_blob (no-op if already Deleted)
        │             - storage::delete_blob (byte destruction)
        │             - delete_blob_gcs_artifacts (thumbnail, VTT, derived audio)
        │             - purge_vcl_cache
        │
        └─ every 100 successes (and at end of run):
              wrangler d1 execute  →  divine-moderation-decisions-prod
                UPDATE creator_deletions
                SET physical_deleted_at = ?
                WHERE blob_sha256 IN (...) AND physical_deleted_at IS NULL
```

**Boundaries:**

- Script is the orchestrator. No new mod-service worker code path; no new HTTP surface.
- Blossom is the only service that touches GCS. The script never decides "delete bytes" — it asks, Blossom acts.
- D1 is the source of truth for "what needs sweeping" (`status='success' AND physical_deleted_at IS NULL`) and "what's been swept" (`physical_deleted_at IS NOT NULL`).

## Components

### 1. Migration `007-creator-deletions-physical-deleted-at.sql`

```sql
-- Stamped by scripts/sweep-creator-deletes.mjs only.
-- The live creator-delete pipeline (process.mjs) does not write this column;
-- newly-produced success rows show NULL here until the next sweep run picks
-- them up, calls Blossom (idempotent if bytes already gone), and stamps.
-- Semantic: "the validation sweep confirmed bytes were destroyed for this row."
ALTER TABLE creator_deletions
  ADD COLUMN IF NOT EXISTS physical_deleted_at TEXT;
```

No new index. The sweep query uses the existing `idx_creator_deletions_status` for the status side and applies the `physical_deleted_at IS NULL` filter on top. Sparse-null filter at thousand-row scale doesn't justify a new index.

### 2. `scripts/sweep-creator-deletes.mjs`

Node ESM, no transpilation. Runs via `node scripts/sweep-creator-deletes.mjs [flags]`.

**CLI flags:**

```
--dry-run                  List candidates and parsed window. No network calls, no D1 writes.
--since=ISO8601            Filter completed_at >= since.
--until=ISO8601            Filter completed_at <  until.
--concurrency=N            Parallel Blossom calls. Default 5.
--limit=N                  Cap candidates fetched (no cap by default).
--blossom-url=URL          Blossom base. Default https://media.divine.video.
--d1-database=NAME         D1 database name. Default divine-moderation-decisions-prod.
```

**Required env:**

- `BLOSSOM_WEBHOOK_SECRET` — Bearer token for Blossom `/admin/moderate`.
- Wrangler must be authed against the production Cloudflare account (script shells out to `wrangler`).
- Node 20+ (global `fetch`, no `node-fetch` dep).

**SQL injection surface:** `wrangler d1 execute --command` does not accept bind params for ad-hoc SQL, so the script string-interpolates inputs into both SELECT and UPDATE statements. Inputs are validated before interpolation:

- `blob_sha256` values must match `/^[0-9a-f]{64}$/`. Anything else is rejected before reaching the SQL builder.
- `--since`, `--until` must parse via `new Date(x).toISOString()` round-trip.
- `--limit` must be a non-negative integer.

A single failed validation aborts the run with exit 3 (D1 read aborted) before any SQL is built.

**Internal functions** (each its own small unit, deps injected so tests don't shell out or fetch):

| Function | Purpose | Side effects |
|---|---|---|
| `parseArgs(argv)` | Returns typed config object. | none (pure). |
| `fetchCandidates(config, exec)` | Shells `wrangler d1 execute ... SELECT`, parses JSON. | reads D1. |
| `fetchUnprocessable(config, exec)` | Shells SELECT for rows with `status='success' AND blob_sha256 IS NULL`. | reads D1. |
| `fetchPermanentFailures(config, exec)` | Shells SELECT for rows with `status LIKE 'failed:permanent:%'`. | reads D1. |
| `callBlossomDelete(sha256, config, fetchImpl)` | One POST, returns `{ok, status, body}`. | network. |
| `runWithConcurrency(items, n, fn)` | Bounded parallelism. No external dep. | none (pure orchestration). |
| `flushDeletedAt(shas, config, exec)` | Shells one `UPDATE ... WHERE blob_sha256 IN (...)`. | writes D1. |
| `printSummary(results)` | Final stdout summary. | stdout. |
| `main()` | Wires it all together. | all of the above. |

### 3. Tests `scripts/sweep-creator-deletes.test.mjs`

Vitest, runs via existing repo config.

| Unit | Coverage |
|---|---|
| `parseArgs` | Defaults; each flag parses; invalid ISO rejected; conflicting flags rejected. |
| `runWithConcurrency` | Concurrency cap respected; error in one item does not poison others; every input produces exactly one result entry; result order need not match input order (callers re-associate via the row data carried through). |
| `callBlossomDelete` | Auth header set; body shape correct; 200 success path; 200-with-`status:'error'` path; 4xx; 5xx; network error. |
| `flushDeletedAt` | SQL builder produces correct `IN (...)` literal; sha256 hex assumption asserted; no-op on empty list. |
| `main` (integration) | Pre-flight `physical_delete_enabled=false` aborts with exit 2 and zero D1 writes. Pre-flight 401 aborts with exit 2. Dry-run path makes zero Blossom and zero D1-write calls. Per-row failure does not stop the sweep. D1 stamp only includes rows that returned `physical_deleted:true`. Unprocessable and permanent-failures surfaced in summary. |

## Data flow

1. **Fetch candidates** from D1:

   ```sql
   SELECT kind5_id, target_event_id, blob_sha256, completed_at
     FROM creator_deletions
    WHERE status = 'success'
      AND physical_deleted_at IS NULL
      AND blob_sha256 IS NOT NULL
      [AND completed_at >= ?since]
      [AND completed_at <  ?until]
    [LIMIT ?limit];
   ```

2. **Empty-candidates short-circuit.** If 0 candidates, skip the sweep entirely. Still run the surfacing queries (step 8) so the operator sees unprocessable / permanent-failure rows. Exit 0 unless those lists are non-empty, in which case exit 1.

3. **Dry-run gate.** If `--dry-run`, print candidate count + first 20 shas + parsed window, exit 0. No network calls, no D1 writes. Pre-flight is intentionally skipped in dry-run; if the flag is misconfigured at run-time, the real run's pre-flight will catch it before any rows get stamped.

4. **Pre-flight.** Issue one Blossom `DELETE` for the first candidate.

   - If response body has `physical_delete_enabled === false`: **abort, exit 2.** Loud message: "Blossom did not byte-delete because `ENABLE_PHYSICAL_DELETE` is off. Flip the flag before sweeping. No D1 writes occurred."
   - If 401/403: **abort, exit 2.** "Blossom rejected auth — check `BLOSSOM_WEBHOOK_SECRET`."
   - If 5xx, network error, JSON parse: **abort, exit 2.** "Blossom unreachable — try later."
   - If success with `physical_deleted: true`: pre-flight row joins the in-memory success queue. It is flushed to D1 alongside the bulk-sweep successes (no separate flush call). Continue to step 5 with the remaining candidates.

5. **Sweep.** `runWithConcurrency(candidates, --concurrency, async row => callBlossomDelete(row.blob_sha256))`.

6. **Strict success criterion** — only stamp `physical_deleted_at` when:

   ```
   res.ok
   && body.status === 'success'
   && body.physical_deleted === true
   ```

   Anything else → log a failure line, continue. Row stays unstamped and is picked up by the next run.

7. **Periodic flush.** Every 100 successes (and once at end-of-run), call `flushDeletedAt(successShas)`:

   ```sql
   UPDATE creator_deletions
      SET physical_deleted_at = ?
    WHERE blob_sha256 IN (?, ?, ...)
      AND physical_deleted_at IS NULL;
   ```

   The `AND physical_deleted_at IS NULL` clause guards against concurrent operators racing each other.

8. **Surface unfulfilled creator intent.** After the sweep, run two read-only queries (these should be small lists — exception rows, not the bulk):

   - `status='success' AND blob_sha256 IS NULL` → "unprocessable" list. Creator's delete was accepted at the kind 5 layer but we never resolved a sha256, so Blossom was never told. The asset may still be live.
   - `status LIKE 'failed:permanent:%'` → "permanent failures" list. The pipeline gave up on these rows; creator's intent was not fulfilled.

9. **Summary** (always printed):

   ```
   === SUMMARY ===
   Total candidates fetched: 1234
   Bytes destroyed + stamped: 1200
   Failed (will retry next run):  34
   Unprocessable (NULL sha256):    5
   Permanent failures (manual):    2

   === FAILURES (will retry) ===
   sha=<hex> http=502 kind5=<id>: <error excerpt>
   ...

   === UNPROCESSABLE (creator intent unfulfilled, NULL sha256) ===
   kind5=<id> target=<id> creator=<pubkey> completed_at=<ts>
   ...

   === PERMANENT FAILURES (creator intent unfulfilled, status=failed:permanent:*) ===
   kind5=<id> target=<id> creator=<pubkey> status=failed:permanent:<sub> last_error=<msg>
   ...

   Exit: 1
   ```

## Per-row outcome log (stdout, JSONL)

```json
{"ts":"...","sha":"<64hex>","kind5":"...","target":"...","outcome":"success","http":200,"physical_deleted":true}
{"ts":"...","sha":"<64hex>","kind5":"...","target":"...","outcome":"failure","http":502,"error":"upstream timeout"}
```

Greppable, sortable, pipeable to `jq`. Every row produces exactly one line.

## Error handling

| Failure | Behavior |
|---|---|
| Pre-flight: `physical_delete_enabled === false` | Abort, exit 2. Zero D1 writes. |
| Pre-flight: Blossom 401/403 | Abort, exit 2. |
| Pre-flight: Blossom 5xx / network / JSON parse | Abort, exit 2. |
| `fetchCandidates` wrangler error | Abort, exit 3. No sweep work started. |
| Per-row Blossom 5xx, 4xx, network, timeout, JSON parse | Log failure line, continue. Row stays unstamped. |
| Per-row Blossom 200 with `status:'error'` or `physical_deleted:false` | Log failure line, continue. Notably: do not stamp. |
| `flushDeletedAt` wrangler error | Abort, exit 4. Print "in-flight chunk shas not stamped" with the sha list, so operator has them for manual reconciliation. Re-run will re-issue DELETE for those (idempotent on Blossom) and stamp on success. |
| SIGINT (Ctrl-C) | Best-effort: stop scheduling new Blossom calls, await in-flight calls to settle, flush in-memory successes, print partial summary, exit 130. Implemented via `process.on('SIGINT', ...)` setting a "draining" flag that the concurrency loop checks. A second SIGINT exits immediately without flushing (operator override). |

**Exit codes:**

- `0` — all good. No failures, no unprocessable, no permanent failures.
- `1` — sweep ran, but at least one creator-intent unfulfilled (any of: failures, unprocessable, permanent-failures non-zero).
- `2` — pre-flight aborted (auth, flag, or unreachable).
- `3` — D1 read aborted.
- `4` — D1 write aborted mid-run.
- `130` — SIGINT.

## Operational runbook (future PR companion)

1. Confirm `ENABLE_PHYSICAL_DELETE=true` is set on Blossom config store.
2. Apply migration 007 to prod D1: `wrangler d1 execute divine-moderation-decisions-prod --file migrations/007-creator-deletions-physical-deleted-at.sql --remote`.
3. Dry-run: `node scripts/sweep-creator-deletes.mjs --dry-run`.
4. If candidate count looks right, full run: `node scripts/sweep-creator-deletes.mjs`.
5. Inspect summary. Investigate any `unprocessable` or `permanent-failures` rows by hand.
6. Re-run any time after the validation window. The sweep is idempotent and converges.

## Open questions

- **Whether to surface `failed:transient:*` rows in the summary.** They will be retried by the existing creator-delete cron (mod-service) and the sweep doesn't own them. Probably skip; revisit if ops finds them useful.

## What this is not

- Not a replacement for the existing live pipeline. New creator deletes after the flag flip are physical-deleted on first pass via the normal sync/cron flow.
- Not a tool for moderator-initiated deletes (BAN, RESTRICT, ageRestrict). Those are separate code paths and out of scope.
