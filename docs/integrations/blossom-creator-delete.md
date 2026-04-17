# Blossom creator-delete integration

Notes on how divine-moderation-service calls Blossom for creator-initiated deletes, and why the current retry/reclaim behavior is compatible with Blossom's contract.

## Source of truth

Blossom's contract for `action: "DELETE"` on `/admin/moderate` is documented in the `divine-blossom` repo:

**`docs/api/creator-delete-contract.md`** ([link](https://github.com/divinevideo/divine-blossom/blob/main/docs/api/creator-delete-contract.md))

That doc is canonical. Anything in this file must defer to it when they disagree.

## How moderation-service calls Blossom

`src/blossom-client.mjs` exports `notifyBlossom(sha256, action, env)`, which posts `{sha256, action: "DELETE", timestamp}` to `BLOSSOM_WEBHOOK_URL` with `Authorization: Bearer <BLOSSOM_WEBHOOK_SECRET>`. The creator-delete pipeline wraps this in a `callBlossomDelete(sha256)` closure (wired in `src/index.mjs`) and hands it to `processKind5` as a dependency. `src/creator-delete/process.mjs` invokes it once per target event in a kind 5 batch.

Response is consumed opaquely: `response.ok` is the only field read today. Fields like `physical_deleted` are not inspected; the blossom contract intentionally allows this (callers can rely on fields without depending on implementation details), so the current pattern is contract-compatible.

## Retry model in process.mjs

Per-target state is tracked in D1 table `creator_deletions`: `{kind5_id, target_event_id, creator_pubkey, blob_sha256, status, accepted_at, completed_at, retry_count, last_error}`. Statuses include `accepted`, `success`, `failed:transient:*`, `failed:permanent:*`. `MAX_RETRY_COUNT = 5`.

HTTP status from Blossom maps to D1 terminal state as follows:

| Blossom outcome | mod-service status | Retry? |
|---|---|---|
| 200 `{success: true}` | `success` | No. Terminal. |
| 5xx | `failed:transient:blossom_5xx` | Yes, until `MAX_RETRY_COUNT`. |
| 429 | `failed:transient:blossom_429` | Yes, until `MAX_RETRY_COUNT`. |
| Network error | `failed:transient:network` | Yes, until `MAX_RETRY_COUNT`. |
| 4xx (other) | `failed:permanent:blossom_<code>` | No. Terminal. |

## Why this is contract-compatible

Blossom's contract (see the canonical doc) guarantees idempotency:

- Repeated `DELETE` for the same sha256 leaves the blob in `Deleted` status and returns a successful response.
- `soft_delete_blob` is a no-op on already-`Deleted` state.
- `storage::delete_blob` treats missing-object (404 from GCS) as success.

This maps onto our retry loop as follows:

**Scenario A: Blossom 5xx after partial state (soft-delete applied, byte-delete failed).** Our next poll re-claims the stale D1 row (via atomic conditional `UPDATE WHERE accepted_at = ?`), re-invokes `callBlossomDelete`. Blossom's `soft_delete_blob` no-ops; its byte-delete retries. If GCS is now healthy, we get `200 physical_deleted: true` and mark `success`. If still failing, another `failed:transient` cycle, bounded by `MAX_RETRY_COUNT`.

**Scenario B: Blossom 5xx with no state change (soft-delete itself failed).** Same retry path. Blossom re-runs the full flow from a clean state. Nothing to undo.

**Scenario C: Response variance across retries.** The first call may have seen `old_status: "active"`; the retry sees `old_status: "deleted"` because the first call's soft-delete already mutated metadata. We don't inspect `old_status` or `physical_deleted` today, so this variance is invisible to us. If we ever start consuming those fields, we should compare outcomes (did the end state match what we wanted) rather than response bytes.

**Scenario D: Race between workers re-claiming a stale row.** The atomic re-claim (`UPDATE ... WHERE accepted_at = ?`) ensures only one worker proceeds. The other observes `reclaimed = false` and reports `in_progress` without calling Blossom. Blossom never sees the racing duplicate.

## Concurrent DELETEs for the same sha256

Our D1 claim scheme prevents two mod-service workers from simultaneously issuing a DELETE for the same `(kind5_id, target_event_id)`. If two *different* kind 5 events from the same or different creators target the same `blob_sha256`, both can issue DELETEs to Blossom concurrently. Blossom's idempotency makes this safe: either both arrive while status is `active` (one wins the update, the other no-ops on already-`Deleted`), or they land on already-deleted state (both are no-ops).

## What this doc does not cover

- Blossom's internal implementation. Read the canonical doc.
- Moderation-service's full creator-delete pipeline (kind 5 parsing, NIP-98 validation, target event resolution, Funnelcake fetching). See `src/creator-delete/` source and the pipeline docs under `docs/superpowers/`.
- The rollout plan across both services. See `support-trust-safety/docs/rollout/2026-04-16-creator-delete-rollout.md` in the support repo.
