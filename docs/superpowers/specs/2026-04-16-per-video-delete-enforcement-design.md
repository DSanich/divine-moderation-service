# Per-Video Delete End-to-End Enforcement

**Date:** April 16, 2026
**Author:** Matt Bradley
**Status:** Draft. Awaiting review.

**Issue:** divine-mobile#3102 (parent #2656; sibling mobile-copy polish #3101)

## Goal

When a creator deletes one of their videos on Divine, the creator sees an honest confirmation, the content is no longer served from any Divine-controlled surface, the bytes are removed from Divine-controlled storage, and support and compliance have a single authoritative record of what happened.

## Motivation

Today the creator-facing confirmation ("Delete request sent successfully") fires on event *creation*, not on relay *acceptance*, and the video's media blob, thumbnail, and transcript remain accessible via direct CDN URLs indefinitely. The code comment in `content_deletion_service.dart` frames this work as Apple App Store compliance. The gap is the immediate trigger for this spec (parent #2656: high-profile creator couldn't tell whether delete worked, three staff members were also confused). Compliance pressure is foreseeable, not hypothetical.

## Current State

**divine-mobile** (`mobile/lib/services/content_deletion_service.dart:125-195`, `mobile/lib/widgets/share_video_menu.dart:1046-1151`) publishes a signed NIP-09 kind 5 event directly to the relay pool. Success is returned on event creation regardless of relay acceptance. No blob cleanup.

**divine-funnelcake** (`crates/relay/src/relay.rs:1235-1331`) verifies kind 5 signature, checks `verify_delete_authorization` (deleter authored each target), inserts accepted targets into ClickHouse `deleted_events_set`, and returns NIP-01 `OK` over the websocket. No outbound notification anywhere in the relay crate.

**divine-blossom** (`src/admin.rs:727-788`) exposes `POST /admin/api/moderate` with actions `BAN|BLOCK|RESTRICT|APPROVE|ACTIVE|PENDING`. `BlobStatus::Deleted` exists but is not wired to any action verb. Thumbnails are stored at deterministic GCS key `{video_sha256}.jpg` and share the main blob's metadata record. VTT transcripts are tracked in KV under `subtitle_hash:` prefix keyed by the main video's sha256 (a `delete_subtitle_data(hash)` function exists). Derived audio maintains bidirectional sha256 mappings.

**Gap:** nothing connects Funnelcake kind 5 acceptance to Blossom blob removal. Mobile's success signal is detached from relay acceptance. No audit trail.

## Design Principle

**Relay-side delete is the critical path and remains independent of moderation-service.** Blob cleanup is a downstream side effect of relay acceptance, handled by a cron-plus-synchronous-endpoint pipeline in moderation-service. Moderation-service failure degrades confirmation UX and cleanup timing, never the relay-side delete. This is the reverse of routing all deletes through moderation-service, which would make mod-service an availability choke-point.

## Architecture

```
  mobile              Funnelcake            moderation-service           Blossom
  ------              ----------            ------------------           -------
  [sign kind 5]  ---> [verify auth]
                      [store deleted_set]
                      [NIP-01 OK]
       |
       |  POST /api/delete/{kind5_id}  (NIP-98, author-only)
       +-----------------------------------> [fetch kind 5 with retries]
                                             [D1 claim: accepted]
                                             [fetch target, sha256]  --->  [DELETE sha256]
                                                                           [status=Deleted]
                                                                           [cascade thumb/vtt]
                                             [D1: success] <---            [200 OK]
       <------------------------------------ [return 200 with result]

       or (partial / slow Blossom):
       <------------------------------------ [return 202, poll status]

    ^                                         ^
    |                                         |
    | GET /api/delete-status/{kind5_id}       |   recovery / fallback path
    +---  NIP-98, author-only  ---------------+

  Parallel path for non-synchronous kind 5s (third-party clients, sync failures):

  [cron every 60s]  ---> [REQ kind:5 since=<last_poll>]  ---> Funnelcake
                         [process each]                        (returns events)
                             |
                             +---> [processKind5]  (same function as sync path)
                         [also retry failed:transient:* rows with retry_count < 5]
```

## Components

### 1. Delete processing pipeline (`divine-moderation-service`)

The pipeline has two triggers that converge on the same processing function. Cloudflare Workers cannot hold a persistent WebSocket subscription in a request-scoped invocation, and this repo has no Durable Object pattern. We match the existing `src/nostr/relay-poller.mjs` shape instead: short-lived REQ queries, state in KV and D1.

#### Shared processing function

`processKind5(kind5Event, env)`: parses `e` tags to enumerate target event IDs; processes each independently (per NIP-09, kind 5 may carry multiple targets). For each target, the function is race-safe against concurrent invocations (e.g., sync endpoint and cron colliding on the same kind 5 within milliseconds):

1. **D1 idempotency claim** using INSERT-OR-IGNORE, then SELECT to read canonical state:

    ```sql
    INSERT INTO creator_deletions
      (kind5_id, target_event_id, creator_pubkey, status, accepted_at)
    VALUES (?, ?, ?, 'accepted', ?)
    ON CONFLICT(kind5_id, target_event_id) DO NOTHING;
    ```

   Then `SELECT` the row. Resolve based on returned state:
   - Row matches this worker's `accepted_at` → this worker claimed it, proceed.
   - Existing `status: success` → return `{skipped: 'already_done'}`.
   - Existing `status: failed:permanent:*` → return `{skipped: 'permanently_failed'}`.
   - Existing `status: accepted` with age < 30s → return `{skipped: 'in_progress'}` (another worker owns it).
   - Existing `status: accepted` with age ≥ 30s → claim it (prior worker likely died); proceed.
   - Existing `status: failed:transient:*` with `retry_count < 5` → claim it for retry; proceed.

2. Fetch the target event (kind 34236) via `fetchNostrEventById`. If fetch fails, update D1 to `failed:permanent:target_unresolved`. Continue to the next target.

3. Extract the main video sha256 from `imeta`/url tags. If missing, update D1 to `failed:permanent:no_sha256`. Continue.

4. Call Blossom `POST /admin/api/moderate` with `{sha256, action: "DELETE"}` using the existing `webhook_secret` Bearer auth.

5. Update D1 based on Blossom response:
   - 2xx → `success` with `completed_at`.
   - 4xx (except 429) → `failed:permanent:blossom_{code}` with `last_error`.
   - 5xx, 429, network, or timeout → `failed:transient:{category}`, increment `retry_count`. If `retry_count >= 5`, upgrade to `failed:permanent:max_retries_exceeded`. Cron retries `failed:transient:*` rows with `retry_count < 5`.

#### State taxonomy

Explicit D1 `status` values:

| Status | Meaning | Retryable? |
|---|---|---|
| `accepted` | Claimed by a worker, processing in progress | n/a |
| `success` | Terminal success | no |
| `failed:transient:blossom_5xx` | Blossom returned 5xx | yes (cron) |
| `failed:transient:blossom_429` | Blossom rate-limited us | yes (cron) |
| `failed:transient:network` | Network error to Funnelcake or Blossom | yes (cron) |
| `failed:transient:timeout` | Request timed out | yes (cron) |
| `failed:permanent:target_unresolved` | Target event could not be fetched from Funnelcake | no |
| `failed:permanent:no_sha256` | Target event missing imeta/url sha256 | no |
| `failed:permanent:blossom_400` | Blossom rejected the request | no |
| `failed:permanent:blossom_403` | Blossom auth failed | no |
| `failed:permanent:blossom_404` | Blossom says blob doesn't exist | no |
| `failed:permanent:max_retries_exceeded` | Transient failure retried 5 times and gave up | operator only |
| `failed:permanent:authz_mismatch` | Caller pubkey does not match kind 5 author (sync endpoint only) | no |

Cron retries only `failed:transient:*` rows where `retry_count < 5` and where `accepted_at` is older than the retry backoff window (e.g., 30s × 2^retry_count up to 5 minutes). Permanent failures stay visible until manual intervention (follow-up operator sweep tool).

#### Trigger A: Synchronous delete endpoint

`POST /api/delete/{kind5_id}` with NIP-98 auth. Mobile calls this after publishing its kind 5 to Funnelcake.

**Auth:** NIP-98 Bearer (Authorization header contains base64-encoded kind 27235 event with `["u", full_url]` and `["method", "POST"]` tags, `created_at` within ±60 seconds of server time). **The caller pubkey MUST match the kind 5 author.** This is enforced after fetching the kind 5 from Funnelcake; mismatches return 403. Operator-triggered recovery from a non-author pubkey is an explicit v2 consideration, not v1.

**Rate-limit:** per-pubkey approximately 5 requests per minute; per-IP approximately 30 per minute.

**Handler flow:**

1. Validate NIP-98; extract caller pubkey. On failure, return 401 (invalid signature) or 400 (malformed payload).
2. Fetch the kind 5 from Funnelcake via `fetchNostrEventById` with retries for the Funnelcake accept→persist race. The kind 5 may have been accepted by Funnelcake's `handle_submitted_event` at `relay.rs:1238` but not yet queryable via REQ because the ClickHouse write is asynchronous (relay.rs:1301 queues for async write). Retry schedule: 0ms, 100ms, 500ms, 1s, 2s. Total budget approximately 3.6 seconds. If not found after retries, return 404.
3. Verify `kind5.pubkey === caller_pubkey`. Mismatch returns 403.
4. Run `processKind5` inline against the fetched kind 5. Internal budget approximately 8 seconds (roughly 2 × typical worst-case).
5. If all targets terminal (`success` or any `failed:*`) within budget, return 200 with the result.
6. If budget exceeds before all targets terminal, return 202 with instruction to poll.

**Response body:**

200 success:
```json
{
  "kind5_id": "...",
  "status": "success",
  "targets": [
    { "target_event_id": "...", "blob_sha256": "...", "status": "success", "completed_at": "2026-04-16T14:02:12Z" }
  ]
}
```

202 in progress (mobile should fall back to polling):
```json
{
  "kind5_id": "...",
  "status": "in_progress",
  "poll_url": "/api/delete-status/{kind5_id}"
}
```

200 with terminal failure (all targets resolved, at least one failed):
```json
{
  "kind5_id": "...",
  "status": "failed",
  "targets": [
    { "target_event_id": "...", "status": "failed:permanent:blossom_400", "last_error": "..." }
  ]
}
```

**Status codes:**

| Code | Meaning |
|---|---|
| 200 | All targets terminal (success or failed); see body |
| 202 | Processing continues; poll the status endpoint |
| 400 | Malformed request or NIP-98 payload invalid |
| 401 | NIP-98 signature verification failed |
| 403 | Caller pubkey does not match kind 5 author |
| 404 | Kind 5 not found on Funnelcake after retries |
| 429 | Rate limit exceeded |
| 500 | Internal error |
| 502 | Blossom unreachable (transient) |

#### Trigger B: Scheduled cron

Cloudflare Worker cron runs every 60 seconds. Uses `relay-client.mjs` to REQ `{kinds:[5], since:<last_poll_ts>}` against `wss://relay.divine.video`, receives events until EOSE, stores new `last_poll_ts` in KV, calls `processKind5` for each event.

**Scope:** catches non-Divine clients publishing kind 5 directly to Funnelcake, and any kind 5 whose synchronous path failed (mobile network hiccup, mod-service transient unavailability, Funnelcake read-after-write race that exceeded the sync endpoint's retry budget).

**Also retries** `failed:transient:*` rows from D1: separate query per cycle targeted at `retry_count < 5 AND accepted_at < now() - backoff(retry_count)`. For each, re-run `processKind5` from step 1.

**Assumption to verify during staging preflight:** Funnelcake's REQ handler returns accepted kind 5 events. Some relays treat kind 5 as ephemeral and drop events after applying the deletion; if that's Funnelcake's behavior, the cron strategy fails. See Staging Preflight below.

#### Latency profile

- **Synchronous path (divine-mobile):** approximately 1-3s typical; up to 8s before the server returns 202 and mobile falls back to polling.
- **Cron path (non-Divine clients, sync failures, transient retries):** up to 90 seconds (60s cron interval + up to 30s processing and retries).

### 2. D1 audit table

New migration `migrations/006-creator-deletions.sql`:

```sql
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

CREATE INDEX idx_creator_deletions_target ON creator_deletions(target_event_id);
CREATE INDEX idx_creator_deletions_creator ON creator_deletions(creator_pubkey);
CREATE INDEX idx_creator_deletions_sha256 ON creator_deletions(blob_sha256);
CREATE INDEX idx_creator_deletions_status ON creator_deletions(status);
```

Indexes support support-team queries ("was event X deleted?", "what has creator Y deleted?", "what happened to blob Z?") and cron sweep queries ("show me `failed:transient:*` rows ready for retry").

### 3. Status endpoint

`GET /api/delete-status/{kind5_id}` on moderation-service. NIP-98 auth required; caller pubkey MUST match the kind 5 author (same rule as §1 Trigger A). Rejects any other pubkey with 403.

Primary use: mobile fallback when the synchronous endpoint returns 202 or times out. Secondary: manual debugging by the creator.

Response: JSON with per-target rows:

```json
{
  "kind5_id": "...",
  "targets": [
    {
      "target_event_id": "...",
      "blob_sha256": "...",
      "status": "success",
      "accepted_at": "2026-04-16T14:02:11Z",
      "completed_at": "2026-04-16T14:02:12Z"
    }
  ]
}
```

Rate-limited per-pubkey (approximately 2 requests/second). Returns 404 if no row exists for the `kind5_id`.

### 4. Mobile delete flow

After the local kind 5 is signed and `_nostrService.publishEvent(deleteEvent)` returns NIP-01 OK:

1. Remove the video from local feeds immediately (`videoEventService.removeVideoCompletely`) — unchanged from today. The creator's view updates instantly while async processing continues.
2. Build a NIP-98 authorization for `POST /api/delete/{kind5_id}` (signed with the same nsec that signed the kind 5).
3. Call the endpoint with a 15-second client timeout.
4. Based on the response:
   - **200 + `status: success`:** terminal success state.
   - **200 + `status: failed`:** terminal failure; surface specific error and offer retry/support affordance.
   - **202:** begin polling `GET /api/delete-status/{kind5_id}` with exponential backoff (500ms, 1s, 2s, 4s, cap 5s) for up to 30 seconds more. Resolve to terminal success/failure as rows reach terminal states.
   - **4xx client error (400, 401, 403):** bug in mobile or the kind 5 itself; surface generic failure, log to Sentry.
   - **429:** client backoff and retry (one retry, then fall back to polling).
   - **502 / 5xx / client timeout:** fall back to polling (mod-service is degraded; cron will catch up).
   - **Network error on endpoint:** fall back to polling (endpoint unreachable or mod-service down; cron will catch up).

The states mobile must represent in the UI:

| Backend state | Mobile state intent |
|---|---|
| Call in progress, no response yet | In-progress indicator; operation has left the device and is being processed |
| 200 success, all targets `success` | Terminal confirmation that Divine-controlled deletion completed |
| 200 + any target `failed:*` | Terminal failure message naming the scope. Partial successes are not rolled back. Retry or support path. |
| 202 + polling resolves to all success | Terminal confirmation (same as above) |
| 202 + polling resolves to failed | Terminal failure (same as above) |
| Polling timeout (status endpoint still in-flight) | Terminal with scoped honesty: content is removed from Divine feeds/profile; cleanup is still in progress |
| Endpoint unreachable (mod-service down) | Terminal with scoped honesty: content is removed from Divine feeds/profile; cleanup may be delayed |

The relay-side delete has already succeeded in every row below the first. The timeout and unreachable states must remain honest at NIP-01 OK: the video is gone from Divine feeds and profile the moment Funnelcake accepts, even when the cleanup tail is pending.

**Exact user-facing strings are owned by #3101** (mobile copy polish). This spec describes state intent only. Coordination note on #3101 to reference this design so the two tickets ship compatible copy.

### 5. Blossom `DELETE` action with cascade and physical removal

PR against `divine-blossom/src/admin.rs` and related:

1. Add `"DELETE" => BlobStatus::Deleted` to the match in `handle_admin_moderate_action` (around line 754).
2. Extend the handler to cascade when the action is `DELETE`:
   - Call `delete_subtitle_data(sha256)` to clear subtitle KV.
   - Clear derived audio references via existing metadata helpers.
   - **Physical GCS byte removal** on the main blob, thumbnail (`{sha256}.jpg`), VTT transcript, and any derived audio. Ordered status-first-then-bytes: the status flip precedes GCS calls so serving is already blocked before destruction begins.
   - **GCS 404 is idempotent success.** If a GCS object doesn't exist (because a prior retry already deleted it), treat as success, not failure. Prevents spurious `failed:gcs_delete` on retries.
   - **Transient GCS errors retried** with exponential backoff (max 3 attempts). Permanent failure returns a distinct error the subscriber records as `failed:transient:gcs_delete` in D1 (cron retries).
3. **Physical-removal flag.** New config value (Fastly config store or env var) `ENABLE_PHYSICAL_DELETE`, default `false`. When `true`, step 2's GCS deletions run. When `false`, the handler flips status and returns `{success: true, physical_delete_skipped: true}` without touching GCS. The flag is useful on first prod deploy (validate pipeline selects correct sha256s without data destruction), for future incident response, and for any scenario where we want to fall back to reversible behavior. Default-off on first prod deploy, flip after validation.
4. Verify serve paths reject `Deleted`. **Dependency: divine-blossom PR #33** is the in-flight work closing these route gaps (HLS HEAD, subtitle-by-hash). Our feature lands on top of #33.
5. **Verify tombstone prevents re-upload.** The vocab alignment doc states that `Deleted` state "prevents re-upload." Scout confirms `BlobStatus::Deleted` exists but the upload-path check is unverified. Blossom PR must include (or verify) that a `PUT` request targeting a sha256 in `Deleted` state is rejected with 409 or equivalent.

Thumbnail cleanup is implicit from the status-flip side: thumbnails live at deterministic GCS key `{sha256}.jpg` and share the main blob's metadata record, so `Deleted` status on the main record is the single source of truth for serving decisions once #33's route checks are consistent. Physical deletion of the thumbnail GCS object is explicit in step 2 regardless.

**One-time cleanup at flag flip:** any blobs set to `Deleted` during the validation window (flag off) retain their GCS bytes. After flipping the flag, run a one-time sweep to physically remove bytes for those stale `Deleted` blobs. This reuses the sweep mechanism used for physical deletion, just with a targeted `status = 'Deleted' AND bytes_still_present` query. Called out in the deploy runbook.

### 6. Vocabulary alignment doc update

Small PR to `support-trust-safety/docs/policy/moderation-vocabulary-alignment.md` adding `creator_delete` as a canonical action:

| Canonical | moderation-service | relay-manager | Blossom | Funnelcake | Reversible? |
|---|---|---|---|---|---|
| `creator_delete` | cron + sync endpoint | (none) | `DELETE` → `Deleted` | `banevent` via creator's own kind 5 | No (without creator consent) |

Origin distinguishment (creator vs admin) lives in the D1 audit layer, not in Blossom state. Blossom's `Deleted` state remains "not served, tombstoned, re-upload prevented." Aligns with Rabble's Apr 12 taxonomy principle (D1 holds decision + audit; Blossom enforces).

## Failure handling

Full matrix below. Every state must be scoped to what is actually known at the time the UI update appears. Exact copy is #3101's; this spec specifies state intent.

| Scenario | Funnelcake | Mod-service | Mobile state intent |
|---|---|---|---|
| All healthy | OK | OK | In-progress → terminal success (~1-3s typical) |
| Funnelcake rejects (unauthorized / missing target / expired) | Reject | n/a | Terminal failure naming the rejection reason |
| Funnelcake unreachable | Fail | n/a | Terminal failure framed as transport problem, retry affordance |
| Funnelcake accepted but sync endpoint returns 404 (read-after-write race exceeded retry budget) | OK | 404 | Fall back to polling. Cron will pick it up within 60s. |
| Funnelcake OK, sync endpoint returns 202 (slow Blossom, partial targets in-flight) | OK | Processing | Fall back to polling; resolves to terminal when all targets settle |
| Funnelcake OK, sync endpoint returns 502 (Blossom down) | OK | Error | Fall back to polling. D1 will record `failed:transient:*`; cron retries. |
| Funnelcake OK, sync endpoint timeout or network error | OK | Unknown | Fall back to polling |
| Funnelcake OK, mod-service entirely down (endpoint unreachable) | OK | Down | Terminal "removed from Divine, cleanup may be delayed." On mod-service recovery, cron catches up and D1 backfills. |
| Funnelcake OK, status flip succeeded, GCS delete fails after retries | OK | D1 records `failed:transient:gcs_delete` → cron retries → if still failing after 5 attempts, `failed:permanent:max_retries_exceeded` | Polling returns `status: failed` → terminal "removed from Divine, cleanup failed" with support path |

On mod-service recovery after an outage, the cron reads its last-seen timestamp from KV and REQs Funnelcake for the missed window. The audit trail eventually becomes complete regardless of outage duration.

## Observability

These alarms are v1 scope, not follow-up, because the "we handle degradation honestly" commitment depends on us detecting it.

- **Sync endpoint latency.** p95 should be under 5s. Alert on p95 > 10s over a 15-minute window (indicates Blossom or Funnelcake slowness).
- **Sync endpoint error rate.** Alert when 5xx rate over 15m > 2%.
- **Cron-path lag** measured as `D1.accepted_at - kind5.created_at` for kind 5s whose first D1 row came from the cron path; alert on p95 > 120s (generous headroom over the 60s cron interval + processing).
- **Blossom call failure rate** above threshold (surfaces Blossom outages or schema drift).
- **Transient retry exhaustion.** Alert on any `failed:permanent:max_retries_exceeded` in the last hour.
- **Pipeline write latency** (`D1.completed_at - D1.accepted_at`) p95 > 30s for cron-path, > 5s for sync path.
- **Dashboard** (Sentry or Grafana) showing end-to-end pipeline health: success rate, p50/p95 per trigger path, failure categories by subcategory.

## Security

- **Blossom admin token** remains in moderation-service only. No new secret propagation. Both cron and sync endpoint use existing `webhook_secret` Bearer.
- **NIP-98 on both sync and status endpoints.** Same auth model, same scope constraint (caller pubkey must match kind 5 author). Consistent reasoning and defense.
- **NIP-98 timestamp tolerance** approximately ±60 seconds to accommodate mobile clock drift. Matches standard NIP-98 recommendations.
- **D1 audit contents** are Divine-internal. Kind5 IDs, sha256s, and creator pubkeys are already public Nostr data; statuses and timestamps are operationally sensitive and gated by NIP-98 when accessed via the public endpoint. Support and compliance queries go through direct D1 access (wrangler or admin UI), not through the public endpoints.
- **Authorization is not re-checked against Funnelcake** by the sync endpoint's post-fetch processing. Funnelcake's kind 5 acceptance has already verified that the creator authored each target. Trusting upstream authz is cleaner than re-implementing it downstream. Matching caller pubkey to kind 5 author (at the endpoint) is the equivalent of checking "the person asking for this kind 5 to be processed is the person who signed it."
- **No Blossom blob deletion without a valid Funnelcake-accepted kind 5.** Both triggers require the kind 5 to exist on Funnelcake before acting on it.

## Testing

- **Unit tests** in moderation-service:
  - `processKind5` event-to-D1 translation (covers parse failures, multi-target, missing imeta).
  - Race safety: two concurrent invocations of `processKind5` for the same (kind5_id, target_event_id). Verify only one performs the Blossom call, the other returns `skipped: in_progress`.
  - Idempotency: retry a previously-successful kind 5, verify `skipped: already_done` and no Blossom call.
  - State taxonomy: Blossom 400 → `failed:permanent:blossom_400`; Blossom 503 → `failed:transient:blossom_5xx`; etc.
- **NIP-98 endpoint tests:**
  - Reject non-author pubkey with 403.
  - Reject expired signature (created_at outside ±60s) with 401.
  - Accept valid signature with matching pubkey.
- **Integration tests** for the Blossom `DELETE` action:
  - Cascade (thumbnail + VTT + derived audio) with flag on.
  - Cascade with flag off (status flip only, GCS untouched).
  - Tombstone prevents re-upload.
  - GCS 404 is idempotent success.
- **End-to-end test (staging, flag on):** publish a kind 5 against staging Funnelcake, call the sync endpoint, verify 200 success, verify Blossom serves 404 on main sha256 + thumbnail (`{sha256}.jpg`) + VTT URL + any derived audio URLs, **and verify the GCS bytes are actually gone** via direct bucket list/head.
- **End-to-end test (staging, flag off):** same pipeline, verify status flip and cascade occur, Blossom 404s, **but GCS bytes remain**. Confirms the flag gates the destructive step correctly.
- **Cron path test (staging):** simulate a non-Divine-client kind 5 (publish without calling sync endpoint), verify cron picks it up within 90s and processes identically.
- **Sync endpoint race test (staging):** publish kind 5, immediately call sync endpoint (within 100ms of NIP-01 OK), verify retry logic handles Funnelcake read-after-write race and the endpoint eventually returns success.

## Dependencies and sequencing

Deploy order matters. Out-of-order deployment creates failure modes that degrade the feature or trip false alarms.

1. **divine-blossom PR #33** must land and deploy first. Without it, `Deleted` status is not consistently checked on serve paths (HLS HEAD, subtitle-by-hash), so blob status flips are cosmetic on those routes.
2. **divine-blossom DELETE-action PR**, flag default-off. Staging first; verify `DELETE` returns success with `physical_delete_skipped: true` when flag off.
3. **divine-moderation-service migration + cron + sync endpoint + status endpoint PR**. Deploys to staging. Verify end-to-end against staging Blossom (flag off) — pipeline executes, Blossom returns success, D1 captures full lifecycle.
4. **divine-mobile polling + UI states PR**. Can develop in parallel against staging mod-service; merges after #3101.
5. **Vocabulary alignment doc PR** alongside Blossom DELETE PR.
6. **Production rollout:** deploy Blossom (flag off), then mod-service, then mobile. Run validation window (suggested: 1 week or first 50 creator-initiated deletes in prod, whichever comes first). Flip `ENABLE_PHYSICAL_DELETE=true` and run the one-time sweep described in §5.

## Staging preflight checklist

Verify before implementation or at the start of implementation (failures here redirect the design):

- [ ] Funnelcake REQ `{"kinds":[5],"limit":5}` against staging returns accepted kind 5 events. If empty (relay treats kind 5 as ephemeral), the cron strategy does not work as specified; surface immediately.
- [ ] Staging Blossom `blossom_secrets` store has `webhook_secret` populated (same pattern as prod).
- [ ] Staging GCS bucket accepts authenticated delete calls from the Blossom identity.
- [ ] Staging mod-service `wrangler.toml` supports a new D1 binding for the audit table (or uses the existing one) and a new cron trigger.
- [ ] Staging has NIP-98 verification path testable end-to-end (nostr-tools signature verification).

## Non-goals and follow-ups (explicit)

- **ClickHouse reconciliation cron.** The 60s REQ cron is the primary durability mechanism. ClickHouse-based reconciliation is only worth building if observed cron miss rate justifies it, and it requires prod ClickHouse read access currently pending with ops.
- **Grace period / creator-initiated un-delete.** Not in scope; creator-initiated deletes are not reversible by creators. Operator recovery (via direct D1 + Blossom admin access) is the escape hatch.
- **Divine backend API for synchronous kind 5 publish (option C from brainstorm).** Foreclosed. Non-Divine clients publishing kind 5 directly to Funnelcake would bypass such an API; cron + sync endpoint covers all ingress uniformly.
- **Multi-relay coverage.** Issue scopes to Divine-controlled. If multi-relay enforcement is ever a requirement, it becomes a separate design.
- **Operator "replay failed delete" tool.** D1 schema supports it via `status LIKE 'failed:permanent:max_retries_exceeded'`. Small CLI or admin UI, v2.
- **Non-author recovery endpoint.** Sync endpoint v1 is author-only. If support needs to re-trigger processing on behalf of a creator (e.g., sync endpoint never called because creator used a different client), a distinct admin-auth endpoint is a v2 consideration.

## Open questions

- **Blossom DELETE action owner.** Who writes the Blossom PR? Available for Matt if no Blossom engineer is picking it up this sprint. The PR is roughly a day of focused work now that physical deletion, the flag, tombstone verification, and tests are in scope.
- **Backup and versioning policy.** If Blossom's GCS bucket has object versioning enabled, or if Divine writes blobs to B2 or another backup tier, then "delete the GCS object" may leave recoverable copies outside the live serving path. Whether that is acceptable depends on the compliance bar we are meeting. Action: (1) scout bucket versioning state and any B2 backup writes, (2) confirm with legal/ops whether backup retention is part of the "remove from storage" promise or a separately-governed lifecycle. This does not block v1 implementation of the main path; it determines whether an additional backup-purge step is required.
- **Interaction with PR #33 timing.** If #33 slips past our target ship date, do we merge our code gated behind a feature flag and wait, or pause? Recommend: merge mod-service (harmless without #33 because Blossom hasn't accepted DELETE yet), hold mobile PR until #33 confirms cascade works end-to-end in staging.
