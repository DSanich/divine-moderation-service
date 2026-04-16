# Relay Replica Backfill Design

## Summary

The current admin metadata path is structurally wrong for the size and age of the moderation corpus. `api.divine.video` is the authoritative source of truth for post and creator context, but the moderation worker still leans on thin, incomplete fields in `moderation_results` and ad hoc fallbacks. The existing backfill endpoint only scans a tiny recent slice of rows and is not a credible solution for hundreds of thousands of moderated videos.

This design turns D1 into a replicated local mirror of `api.divine.video` data for videos and creators, while keeping `api.divine.video` authoritative. A resumable local backfill script will hydrate the mirror directly into production D1, and the admin worker will switch to a read-through/write-through model: use mirrored data when present, fetch from `api.divine.video` when it is missing or stale, and write the fresh result back into D1.

## Goals

- Make `api.divine.video` the explicit source of truth for admin post and creator context.
- Mirror authoritative video and creator data into D1 in a schema that matches the upstream model instead of squeezing everything into `moderation_results`.
- Provide a real bulk backfill path that can repair hundreds of thousands of rows from a laptop, resume after interruption, and avoid redundant work.
- Improve admin lookup latency and resilience by serving from D1 when mirrored data is already present and fresh.
- Keep moderation workflow state in `moderation_results`, but stop treating it as the canonical metadata store.

## Non-Goals

- Rebuilding the full Divine product database in this worker.
- Making D1 the new authority over `api.divine.video`.
- Changing moderation decisions or classifier thresholds as part of the metadata migration.
- Migrating every historical surface in one step. This design focuses on admin lookup and Quick Review first.

## Current Problems

### `moderation_results` is the wrong shape

The table stores moderation state well enough, but it only has a few metadata columns: `uploaded_by`, `title`, `author`, `event_id`, `content_url`, `published_at`, and `raw_response`. That is not enough to represent the actual event and creator payloads the admin UI needs.

### The current backfill endpoint does not scale

`/admin/api/backfill-review-context` only selects a small recent slice of rows from `moderation_results`, filters them in memory, and repairs at most `100` rows per request. It cannot walk the full sparse backlog, cannot checkpoint real progress through the table, and is not suitable for `300k+` rows.

### Admin lookup is still brittle

Admin lookup can now enrich from `api.divine.video`, but it is still constrained by the old local schema. The worker has to infer too much from partial rows and snapshots because there is no proper mirrored video/creator model in D1.

## Source-of-Truth Model

- `api.divine.video` remains authoritative.
- D1 becomes a replicated local mirror and fallback cache.
- Admin read paths should prefer mirrored D1 data when it is complete and fresh enough.
- If mirrored data is missing, incomplete, or stale, the worker should fetch from `api.divine.video`, return that result, and write it back into D1.

This allows admin to get better immediately without waiting for the entire historical backfill to finish.

## Proposed Schema

### `relay_videos`

Mirror table keyed by media SHA256.

Purpose:
- represent the canonical upstream video/event record used by admin
- store both explicit queryable columns and the upstream normalized payload

Recommended columns:

- `sha256 TEXT PRIMARY KEY`
- `event_id TEXT`
- `stable_id TEXT`
- `pubkey TEXT`
- `title TEXT`
- `content TEXT`
- `summary TEXT`
- `video_url TEXT`
- `thumbnail_url TEXT`
- `published_at TEXT`
- `created_at TEXT`
- `author_name TEXT`
- `author_avatar TEXT`
- `provider TEXT`
- `raw_json TEXT NOT NULL`
- `synced_at TEXT NOT NULL`
- `source_updated_at TEXT`

Recommended indexes:

- `INDEX relay_videos_event_id_idx (event_id)`
- `INDEX relay_videos_stable_id_idx (stable_id)`
- `INDEX relay_videos_pubkey_idx (pubkey)`
- `INDEX relay_videos_synced_at_idx (synced_at)`

### `relay_creators`

Mirror table keyed by creator pubkey.

Purpose:
- represent the canonical upstream creator/profile/social record used by admin
- decouple creator context from individual moderation rows

Recommended columns:

- `pubkey TEXT PRIMARY KEY`
- `display_name TEXT`
- `username TEXT`
- `avatar_url TEXT`
- `bio TEXT`
- `website TEXT`
- `nip05 TEXT`
- `follower_count INTEGER`
- `following_count INTEGER`
- `video_count INTEGER`
- `event_count INTEGER`
- `first_activity TEXT`
- `last_activity TEXT`
- `raw_json TEXT NOT NULL`
- `synced_at TEXT NOT NULL`

Recommended indexes:

- `INDEX relay_creators_username_idx (username)`
- `INDEX relay_creators_synced_at_idx (synced_at)`

### `moderation_results`

Keep this table for moderation state. It still stores:

- action/review/provider/scores/categories
- moderation timestamps and reviewer information
- a small denormalized slice used directly by admin

It should continue to hold or gain the fields that make admin rendering fast:

- `uploaded_by`
- `event_id`
- `content_url`
- `title`
- `author`
- `published_at`

But those fields should be treated as denormalized convenience copies from the mirrored video/creator data, not the canonical metadata store.

## Data Model Mapping

### Video mirror

Each mirrored video row should be built from the authoritative `api.divine.video` response plus normalized fields already expected by the admin worker:

- canonical IDs: event id, stable id, media sha
- author linkage: pubkey, author name, author avatar
- renderable post context: title, content, summary, publish/create timestamps
- media context: playback URL, thumbnail URL
- full upstream payload: `raw_json`

### Creator mirror

Each mirrored creator row should be built from the relevant upstream creator/profile endpoints:

- display identity: display name, username, avatar, bio, nip05
- public counts and account activity dates
- full upstream payload: `raw_json`

## Read Path Design

### Admin video lookup

For admin lookup and Quick Review:

1. read moderation state from `moderation_results`
2. try to read a complete `relay_videos` mirror row by SHA256
3. if the mirror row exists and is fresh enough, build the admin response from the mirror plus moderation state
4. if the mirror row is missing, incomplete, or stale:
   - fetch authoritative video context from `api.divine.video`
   - upsert `relay_videos`
   - upsert `relay_creators` when a pubkey exists
   - refresh the denormalized fields in `moderation_results`
   - return the newly resolved result
5. only fall back to legacy local scraps (`raw_response`, `video_metadata`, `bunny_webhook_events`) when upstream truly has nothing

### Freshness

The first iteration should keep freshness simple:

- if the mirrored row is complete and `synced_at` is recent enough, serve it
- otherwise refetch and overwrite

The threshold can be environment-configurable later if needed.

## Backfill Job Design

### Why local

The real bulk repair should run from a laptop, not through a worker endpoint:

- the job needs to process hundreds of thousands of rows
- it needs progress visibility and restartability
- it should not be constrained by worker request/runtime limits

### Cursor and checkpointing

The backfill script should walk sparse moderation rows in deterministic order using a stable tuple cursor:

- `moderated_at DESC`
- `sha256 DESC`

The script should persist a checkpoint file after every batch containing:

- last `moderated_at`
- last `sha256`
- totals for scanned, repaired, unresolved, failed
- timestamps for start and last update

This allows exact resume without relying on drifting offsets.

### Batch behavior

For each batch:

1. query the next sparse moderation rows directly from D1 using SQL predicates for missing metadata
2. for each row:
   - fetch authoritative video context from `api.divine.video`
   - normalize and upsert `relay_videos`
   - fetch/upsert `relay_creators` when applicable
   - refresh denormalized columns in `moderation_results`
3. write the checkpoint
4. print progress

### Idempotence

The script must be safe to rerun:

- upserts replace mirrored rows with the current authoritative payload
- denormalized moderation fields are refreshed from the mirror
- overlapping restart windows are acceptable because a second run becomes a no-op for already repaired rows

## Failure Handling

- upstream miss:
  mark unresolved, continue
- transient network error:
  retry a small number of times, then count failed and continue
- D1 write failure:
  stop the run, because continuing after failed writes corrupts progress accounting
- malformed upstream payload:
  count failed with enough context to inspect later

## Migration Plan

1. add D1 migrations for `relay_videos` and `relay_creators`
2. add normalization/upsert helpers in the worker codebase
3. change admin read paths to use mirrored rows first with `api.divine.video` write-through fallback
4. build the local resumable backfill script
5. run the historical backfill into production D1
6. remove dependence on skinny `moderation_results` metadata wherever practical

## Testing Strategy

Add coverage for:

- schema migration assumptions and mirror upsert helpers
- admin lookup preferring mirrored D1 data when complete
- admin lookup refetching and writing through when mirrored rows are missing or stale
- creator mirror upserts from upstream profile payloads
- local backfill batch cursor behavior and checkpoint resume logic
- denormalized `moderation_results` refresh after mirrored writes
