# Relay-to-D1 Context Cache And Backfill

**Date:** 2026-04-16
**Status:** Approved
**Scope:** admin review context caching, persistence, and moderator-facing empty states in `divine-moderation-service`

## Problem

Quick Review still depends on sparse local moderation rows for many historical items. When the admin worker cannot resolve current relay context, it falls back to thin local metadata and recently leaked internal diagnostic labels into the moderator UI.

Current problems:
- `api.divine.video` is the right source of truth, but the worker does not persist resolved relay context back into D1 consistently.
- Historical `REVIEW` rows often have `null` for `event_id`, `uploaded_by`, title, author, and content URL.
- Relay lookups happen at display time, but successful lookups are not treated as durable repairs to the local cache.
- Quick Review exposed internal fallback state in moderator-facing copy.

## User Intent

The moderator wants `api.divine.video` to remain primary, but any successful relay lookup should repair the neglected D1 cache so the same video does not keep resolving from scratch. Historical rows should also be repairable by a backfill path, and the UI should never expose internal fallback jargon.

## Design

Make the admin worker a read-through and write-through cache for relay context.

### Source Of Truth

For normal content:
- `api.divine.video` is the authority for post and creator context.
- D1 stores a local snapshot of resolved relay context for durability and speed.

For deleted, missing, or unreachable upstream content:
- D1 remains the fallback source so moderators can still act on the row.

### Cache Strategy

When the worker resolves relay context successfully during:
- ingest/classification
- admin video lookup
- Quick Review context lookup

it should persist the useful fields back into D1 immediately.

Persist at least:
- `event_id`
- stable post id / `d` tag when recoverable
- `uploaded_by`
- `title`
- `author`
- `content_url`
- `published_at`
- post body snapshot when available

This turns successful relay hydration into a repair of the local cache instead of a one-off display-only win.

### Backfill Strategy

Add a backfill path for historical moderated rows with thin metadata.

The backfill should:
- scan rows missing core context
- resolve them through `api.divine.video` using the best available identifier
- update D1 only when upstream returns a valid record
- skip rows that still have no recoverable upstream context

This can be exposed as an admin or script-driven repair path; the important part is that the persistence logic is shared with live lookup so there is one normalization/update flow.

### Data Model

Use existing admin/D1 tables first rather than inventing a new local source of truth.

`moderation_results` should receive the core fields already used by admin surfaces.
`video_metadata` can be used as an auxiliary cache when it already fits a field naturally, but the admin surfaces should not depend on it as the canonical record.

### UI Behavior

Quick Review and creator info should stay moderator-friendly.

Rules:
- never show internal state names like `legacy_moderation_row_without_context`
- never show diagnostic labels like `Legacy moderation row`
- use neutral empty states such as `Post details unavailable` and `Creator details unavailable`
- keep technical metadata focused on real moderation data, not internal fallback reasoning

### Non-Goals

- No direct browser calls to relay REST from Quick Review
- No attempt to invent missing context when relay and D1 both lack it
- No new permanent UI for internal cache/debug status

## Testing

Add coverage for:
- persisting relay-resolved context back into D1 during admin lookup
- ingest or lookup using cached D1 context after a successful repair
- backfill path updating rows that are missing core fields
- Quick Review and creator modal using neutral empty-state copy instead of internal diagnostic terms
