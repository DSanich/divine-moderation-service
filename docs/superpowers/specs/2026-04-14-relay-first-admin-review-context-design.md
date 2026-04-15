# Relay-First Admin Review Context

**Date:** 2026-04-14
**Status:** Approved
**Scope:** quick review and admin lookup context hydration in `divine-moderation-service`

## Problem

Quick Review usually shows weak post context because the admin worker relies on sparse local moderation rows and raw relay websocket lookups.

Current problems:
- `moderation_results` is not reliable enough to be the primary source of post context.
- The admin APIs return thin review rows and then attempt best-effort enrichment later.
- Raw websocket lookups are used for fields that the relay docs say should come from REST denormalized endpoints.
- Profile misses are cached aggressively, so `Unknown publisher` persists even after transient lookup failures.

## User Intent

The moderator wants Quick Review to use the same fast, accurate post context source as the main product, not a neglected local snapshot.

The explicit rule is:
- use `api.divine.video` first
- use admin/D1 only as fallback for deleted or missing content

## Design

Make relay REST the primary source of truth for admin review context.

### Source Of Truth

For non-deleted content:
- post metadata comes from relay/API responses first
- publisher metadata comes from relay/API responses first

For deleted, missing, or unreachable relay content:
- fall back to local admin/D1 metadata so moderation can still proceed

### Resolution Order

For a given review item:

1. Load moderation state from the admin worker as today.
2. Resolve post context from `api.divine.video` using the best available stable identifier.
3. Merge relay fields over local placeholders.
4. Use local admin/D1 metadata only for fields still missing or when relay says the content is gone.
5. Use raw websocket relay lookups only as a last resort.

### Identifier Strategy

Use identifiers in this order:

1. `event_id` from persisted moderation metadata
2. stable video identifier / `d` tag when available
3. relay/API lookup identifiers already returned by FunnelCake lookup
4. media SHA only as a fallback path when no stable post identifier exists

The goal is to stop treating media SHA as the primary external post identifier.

### API Changes

Introduce a server-side relay-first enrichment helper used by admin lookup endpoints.

It should:
- fetch single-video context from relay REST
- fetch publisher profiles from relay/API bulk user endpoints when pubkeys are known
- normalize the response into the existing admin review payload shape

Admin endpoints should return:
- moderation state from local admin data
- post and publisher context from relay/API when available
- local fallback data only when upstream data is unavailable

### UI Behavior

Quick Review should continue calling the admin worker, not the relay directly from the browser.

That keeps:
- auth simple
- fallback logic centralized
- payload shape stable for the existing UI

### Non-Goals

- No change to moderation decisions or playback routing
- No attempt to fully repair or trust all legacy D1 rows
- No new background sync from relay into D1

## Testing

Add coverage for:
- relay-first enrichment when relay/API returns a complete post
- fallback to local admin metadata when relay/API returns 404 or errors
- publisher hydration preferring relay/API data over local placeholders
- merge behavior that does not clobber good relay fields with sparse local data
