# Per-Video Delete End-to-End Enforcement

**Date:** April 16, 2026
**Author:** Matt Bradley
**Status:** Draft. Awaiting review.

**Issue:** divine-mobile#3102 (parent #2656; sibling mobile-copy polish #3101)

## Goal

When a creator deletes one of their videos on Divine, the creator sees an honest confirmation, the content is no longer served from any Divine-controlled surface, and support and compliance have a single authoritative record of what happened.

## Motivation

Today the creator-facing confirmation ("Delete request sent successfully") fires on event *creation*, not on relay *acceptance*, and the video's media blob, thumbnail, and transcript remain accessible via direct CDN URLs indefinitely. The code comment in `content_deletion_service.dart` frames this work as Apple App Store compliance. The gap is the immediate trigger for this spec (parent #2656: high-profile creator couldn't tell whether delete worked, three staff members were also confused). Compliance pressure is foreseeable, not hypothetical.

## Current State

**divine-mobile** (`mobile/lib/services/content_deletion_service.dart:125-195`, `mobile/lib/widgets/share_video_menu.dart:1046-1151`) publishes a signed NIP-09 kind 5 event directly to the relay pool. Success is returned on event creation regardless of relay acceptance. No blob cleanup.

**divine-funnelcake** (`crates/relay/src/relay.rs:1235-1331`) verifies kind 5 signature, checks `verify_delete_authorization` (deleter authored each target), inserts accepted targets into ClickHouse `deleted_events_set`, and returns NIP-01 `OK` over the websocket. No outbound notification anywhere in the relay crate.

**divine-blossom** (`src/admin.rs:727-788`) exposes `POST /admin/api/moderate` with actions `BAN|BLOCK|RESTRICT|APPROVE|ACTIVE|PENDING`. `BlobStatus::Deleted` exists but is not wired to any action verb. Thumbnails are stored at deterministic GCS key `{video_sha256}.jpg` and share the main blob's metadata record. VTT transcripts are tracked in KV under `subtitle_hash:` prefix keyed by the main video's sha256 (a `delete_subtitle_data(hash)` function exists). Derived audio maintains bidirectional sha256 mappings.

**Gap:** nothing connects Funnelcake kind 5 acceptance to Blossom blob removal. Mobile's success signal is detached from relay acceptance. No audit trail.

## Design Principle

**Relay-side delete is the critical path and remains independent of moderation-service.** Blob cleanup is a downstream side effect of relay acceptance, handled by a subscriber worker. Moderation-service failure degrades confirmation UX and cleanup timing, never the relay-side delete. This is the reverse of routing all deletes through moderation-service, which would make mod-service an availability choke-point.

## Architecture

```
  mobile              Funnelcake            moderation-service           Blossom
  ------              ----------            ------------------           -------
  [sign kind 5]  ---> [verify auth]
                      [store deleted_set]
                      [NIP-01 OK]       ---> (event broadcast)
                                              |
                                              v
                                        [subscriber receives]
                                        [D1: row received]
                                        [fetch target, sha256]  --->  [DELETE sha256]
                                                                      [status=Deleted]
                                                                      [cascade thumb/vtt]
                                        [D1: row success] <---        [200 OK]
    ^                                         |
    | GET /api/delete-status/{kind5_id}       |
    +---  NIP-98 auth  -----------------------+
```

## Components

### 1. Subscriber worker (`divine-moderation-service`)

New module tails a websocket subscription to `wss://relay.divine.video` with filter `{kinds:[5]}`. On each accepted kind 5:

1. Parse `e` tags to enumerate target event IDs. Per NIP-09 semantics, kind 5 may carry multiple targets; process each independently.
2. For each target: write a D1 row (status `accepted`), fetch the target event (kind 34236) via `fetchNostrEventById`, extract the main video sha256 from `imeta`/url tags. If target fetch fails, update D1 to `failed:target_unresolved` and continue to the next target.
3. Call Blossom `POST /admin/api/moderate` with `{sha256, action: "DELETE"}` using the existing `webhook_secret` Bearer auth.
4. Update D1 row to `success` with `completed_at`, or to `failed:{reason}` with `last_error` and `retry_count` increment. Retry transient failures with exponential backoff (max 5 attempts, cap 5 minutes).

Subscription persistence follows the existing `src/nostr/relay-poller.mjs` pattern in moderation-service, extended to record the last-seen timestamp in a Durable Object. On reconnect, the subscription uses `since=<last_seen>` so missed kind 5s are replayed through normal Nostr semantics. No separate reconciliation job required in v1.

Idempotency: composite PRIMARY KEY `(kind5_id, target_event_id)` in D1 with UPSERT. Duplicate deliveries (reconnect overlap, repeated `e` tags within one kind 5) are harmless.

### 2. D1 audit table

New migration in `divine-moderation-service/migrations/`:

```sql
CREATE TABLE IF NOT EXISTS creator_deletions (
  kind5_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  creator_pubkey TEXT NOT NULL,
  blob_sha256 TEXT,
  status TEXT NOT NULL,             -- accepted|success|failed:{reason}
  accepted_at TEXT NOT NULL,        -- ISO8601 timestamp the subscriber accepted the kind 5 into the pipeline
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

Indexes support support-team queries ("was event X deleted?", "what has creator Y deleted?", "what happened to blob Z?") and operator sweep queries ("show me all `failed:*` rows since yesterday").

### 3. Status endpoint

`GET /api/delete-status/{kind5_id}` on moderation-service. NIP-98 auth required: the caller signs the HTTP request with the same nsec that authored the kind 5. Rejects any pubkey other than the kind5 author.

Response: JSON array of per-target status rows (length 1 for divine-mobile today, can be longer for bulk-delete clients):

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

Rate-limited per-pubkey (approximately 2 requests/second). Returns 404 if no row exists for the kind5_id (subscriber has not yet observed it).

### 4. Mobile polling and two-state UI

After `_nostrService.publishEvent(deleteEvent)` returns NIP-01 OK, mobile begins polling `GET /api/delete-status/{kind5_id}` with exponential backoff (500ms, 1s, 2s, 4s, cap 5s) for up to 30 seconds total.

The states mobile must represent in the UI:

| Backend state | Mobile state intent |
|---|---|
| Polling in progress, no row yet | In-progress indicator; operation has left the device and is being processed |
| All targets `status: success` | Terminal confirmation that Divine-controlled deletion completed |
| Partial success (some `success`, some `accepted`/in-flight) | In-progress continues until terminal; resolves to one of the terminal states below |
| Any target `status: failed:*` (others may be `success`) | Terminal failure message naming the scope (e.g., N of M targets). Partial successes are not rolled back. Retry or support path. |
| Polling timeout (still accepted/in-flight) | Terminal with scoped honesty: content is removed from Divine feeds/profile; cleanup is still in progress |
| Endpoint unreachable (mod-service down) | Terminal with scoped honesty: content is removed from Divine feeds/profile; cleanup may be delayed |

The relay-side delete has already succeeded in every row below the first. The timeout and unreachable states must remain honest at NIP-01 OK: the video is gone from Divine feeds and profile the moment Funnelcake accepts, even when the cleanup tail is pending.

Local-feed removal (`videoEventService.removeVideoCompletely`) fires at NIP-01 OK, unchanged from today.

**Exact user-facing strings are owned by #3101** (mobile copy polish). This spec describes state intent only. Coordination note on #3101 to reference this design so the two tickets ship compatible copy.

### 5. Blossom `DELETE` action with cascade and physical removal

PR against `divine-blossom/src/admin.rs` and related:

1. Add `"DELETE" => BlobStatus::Deleted` to the match in `handle_admin_moderate_action` (around line 754).
2. Extend the handler to cascade when the action is `DELETE`:
   - Call `delete_subtitle_data(sha256)` to clear subtitle KV.
   - Clear derived audio references via existing metadata helpers.
   - **Physical GCS byte removal** on the main blob, thumbnail (`{sha256}.jpg`), VTT transcript, and any derived audio. Ordered status-first-then-bytes: the status flip precedes GCS calls so serving is already blocked before destruction begins. Transient GCS errors retried with exponential backoff (max 3 attempts). Permanent failure returns a distinct error the subscriber records as `failed:gcs_delete` in D1.
3. **Physical-removal flag.** New config value (Fastly config store or env var) `ENABLE_PHYSICAL_DELETE`, default `false`. When `true`, step 2's GCS deletions run. When `false`, the handler flips status and returns `{success: true, physical_delete_skipped: true}` without touching GCS. The flag is useful on first prod deploy (validate pipeline selects correct sha256s without data destruction), for future incident response, and for any scenario where we want to fall back to reversible behavior. Default-off on first prod deploy, flip after validation.
4. Verify serve paths reject `Deleted`. **Dependency: divine-blossom PR #33** is the in-flight work closing these route gaps (HLS HEAD, subtitle-by-hash). Our feature lands on top of #33.

Thumbnail cleanup is implicit from the status-flip side: thumbnails live at deterministic GCS key `{sha256}.jpg` and share the main blob's metadata record, so `Deleted` status on the main record is the single source of truth for serving decisions once #33's route checks are consistent. Physical deletion of the thumbnail GCS object is explicit in step 2 regardless.

One-time cleanup at flag flip: any blobs set to `Deleted` during the validation window (flag off) retain their GCS bytes. After flipping the flag, run a one-time sweep to physically remove bytes for those stale `Deleted` blobs. This reuses the sweep mechanism used for physical deletion, just with a targeted `status = 'Deleted' AND bytes_still_present` query. Call it out in the deploy runbook.

### 6. Vocabulary alignment doc update

Small PR to `docs/policy/moderation-vocabulary-alignment.md` adding `creator_delete` as a canonical action:

| Canonical | moderation-service | relay-manager | Blossom | Funnelcake | Reversible? |
|---|---|---|---|---|---|
| `creator_delete` | subscriber worker | (none) | `DELETE` → `Deleted` | `banevent` via creator's own kind 5 | No (without creator consent) |

Origin distinguishment (creator vs admin) lives in the D1 audit layer, not in Blossom state. Blossom's `Deleted` state remains "not served, tombstoned, re-upload prevented." This aligns with Rabble's Apr 12 taxonomy principle (D1 holds decision + audit; Blossom enforces).

## Failure handling

Full matrix below. Every state must be scoped to what is actually known at the time the UI update appears. Exact copy is #3101's; this spec specifies the state intent.

| Scenario | Funnelcake | Mod-service | Mobile state intent |
|---|---|---|---|
| All healthy | OK | OK | In-progress → terminal success (~1-3s typical) |
| Funnelcake rejects (unauthorized / missing target / expired) | Reject | n/a | Terminal failure naming the rejection reason |
| Funnelcake unreachable | Fail | n/a | Terminal failure framed as transport problem, retry affordance |
| Funnelcake OK, mod-service down | OK | Down | In-progress → polling fails → terminal "removed from Divine, cleanup may be delayed" |
| Funnelcake OK, mod-service slow | OK | Slow | In-progress → polling eventually succeeds → terminal success |
| Funnelcake OK, Blossom call fails after retries | OK | D1 records `failed:{reason}` | Polling returns `status: failed` → terminal "removed from Divine, cleanup failed" with support path |
| Funnelcake OK, status flip OK, GCS delete fails after retries | OK | D1 records `failed:gcs_delete` | Polling returns `status: failed:gcs_delete` → same as above (content not served, physical bytes may still exist, operator sweep can retry) |

On mod-service recovery after an outage, the subscriber reconnects via `since=<last-timestamp>` and backfills D1. The audit trail eventually becomes complete regardless of outage duration.

## Observability

These alarms are v1 scope, not follow-up, because the "we handle degradation honestly" commitment depends on us detecting it.

- **Status endpoint error rate** above threshold (Sentry alert on mod-service).
- **Subscriber lag** measured as `D1.accepted_at - kind5.created_at`; alert on p95 > 60s.
- **Blossom call failure rate** above threshold (surfaces Blossom outages or schema drift).
- **Subscriber write latency** divergence (`D1.completed_at - D1.accepted_at`) p95 > 30s.
- **Dashboard** (Sentry or Grafana) showing end-to-end pipeline health: success rate, p50/p95 per leg, failure categories.

## Security

- **Blossom admin token** remains in moderation-service only. No new secret propagation. Subscriber uses existing `webhook_secret` Bearer.
- **NIP-98 on status endpoint** prevents third-party callers from using the endpoint as a free Divine infrastructure monitor.
- **D1 audit contents** are Divine-internal. Kind5 IDs, sha256s, and creator pubkeys are already public Nostr data; statuses and timestamps are operationally sensitive and gated by NIP-98 when accessed via the public endpoint. Support and compliance queries go through direct D1 access (wrangler or admin UI), not through the public status endpoint.
- **Authorization is not re-checked** by the subscriber. Funnelcake already rejects unauthorized kind 5s before the subscriber sees them. Trusting upstream authz is cleaner than re-implementing it downstream.
- **No Blossom blob deletion without a valid accepted kind 5.** The subscriber only acts on events it observes via the authenticated websocket from Funnelcake.

## Testing

- **Unit tests** in moderation-service for subscriber event-to-D1 translation (covers parse failures, multi-target, missing imeta, duplicate kind 5s).
- **Integration tests** for the Blossom DELETE action cascade (thumbnail + VTT cleanup; tombstone prevents re-upload).
- **End-to-end test** (staging, flag on): publish a kind 5 against staging Funnelcake, observe D1 row progression, verify Blossom serves 404 on main sha256 + thumbnail (`{sha256}.jpg`) + VTT URL + any derived audio URLs, **and verify the GCS bytes are actually gone** via direct bucket list/head.
- **Flag-off test** (staging): same pipeline but with `ENABLE_PHYSICAL_DELETE=false`. Verify status flip + cascade metadata clearing occur, Blossom 404s, **but GCS bytes remain**. Confirms the flag gates the destructive step correctly.
- **Mobile widget tests** for the polling state machine (all UI branches in the failure matrix).
- **NIP-98 endpoint tests**: reject non-author pubkey, reject expired signature, accept valid.

## Dependencies and sequencing

1. **divine-blossom PR #33** must land first (route gaps for `Deleted` status on HLS HEAD and subtitle-by-hash). If #33 is still open when we start, our spec tracks its status.
2. **divine-blossom DELETE action PR** (small). Merged behind PR #33.
3. **divine-moderation-service migration + subscriber + status endpoint PR**. Deploys to staging first.
4. **divine-mobile polling + UI states PR**. Can develop in parallel against a staging mod-service, merges after #3101.
5. **Vocabulary alignment doc PR** alongside Blossom DELETE PR.

Staging verification before production: publish a kind 5 via a test account with `ENABLE_PHYSICAL_DELETE=true` in staging, observe full lifecycle in D1, confirm direct-CDN 404, confirm GCS bytes gone. Production first-deploy ships with `ENABLE_PHYSICAL_DELETE=false`. After a validation window (suggested: 1 week or first 50 creator-initiated deletes in prod, whichever comes first), flip to `true` and run the one-time sweep described in §5.

## Non-goals and follow-ups (explicit)

- **ClickHouse reconciliation cron (option D).** Nostr's native `since`-based reconnect is the primary durability mechanism. Only worth building if observed subscriber miss rate justifies it.
- **Grace period / creator-initiated un-delete.** Product decision, not infrastructure. If ever wanted, the tombstone-prevents-re-upload behavior would need a bypass for the same creator.
- **Divine backend API for synchronous delete (option C).** Foreclosed in this spec by design. Non-Divine clients publishing kind 5 directly to Funnelcake would bypass the API; B + subscriber covers all ingress uniformly.
- **Multi-relay coverage.** Issue scopes to Divine-controlled. If multi-relay enforcement is ever a requirement, it becomes a separate design.
- **Operator "replay failed delete" tool.** D1 schema supports it via `status LIKE 'failed:%' AND retry_count < N`. Small CLI or admin UI, v2.

## Open questions

- **Blossom DELETE action owner.** Who writes the Blossom PR? Available for Matt if no Blossom engineer is picking it up this sprint. The PR is no longer trivial (physical-deletion cascade + flag + tests), call it a day of focused work.
- **Subscriber location.** Confirmed to add to `divine-moderation-service` rather than a new Worker. Reuses existing Blossom admin auth, existing relay-client module, existing Durable Object patterns.
- **Interaction with PR #33 timing.** If #33 slips past our target ship date, do we merge our code gated behind a feature flag and wait, or pause our work? Recommend: merge our subscriber and D1 layers (harmless without #33), hold mobile PR until #33 confirms cascade works end-to-end in staging.
- **Backup and versioning policy.** If Blossom's GCS bucket has object versioning enabled, or if Divine writes blobs to B2 or another backup tier, then "delete the GCS object" may leave recoverable copies outside the live serving path. Whether that is acceptable depends on the compliance bar we are meeting. Action: (1) scout bucket versioning state and any B2 backup writes, (2) confirm with legal/ops whether backup retention is part of the "remove from storage" promise or a separately-governed lifecycle. This does not block v1 implementation of the main path; it determines whether an additional backup-purge step is required.
