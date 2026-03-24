# Quick Review Sort Controls

**Date:** 2026-03-24
**Status:** Approved
**Scope:** divine-moderation-service, frontend only

## Problem

The quick review (swipe review) UI sorts AI-flagged items by highest Hive AI score, but this is invisible to the moderator. There is no indication of sort order and no way to change it. Aleysha has no context for why items appear in the order they do.

## Current Behavior

- `/admin/api/videos?action=FLAGGED&limit=100` returns items `ORDER BY moderated_at DESC` from D1
- Client re-sorts by `getMaxScore(scores)` descending (highest AI confidence first)
- Untriaged items (no AI scores) are appended after all flagged items; with ~55K pending flagged items, the untriaged tail is never reached
- A "since" date filter dropdown already exists in the header

## Design

Add a sort dropdown to the quick review header, next to the existing "since" filter.

### Sort Options

| Label | Behavior | Notes |
|-------|----------|-------|
| By score | Highest max Hive AI score first | Current default, now made visible |
| Newest | Most recently classified first (`moderated_at` DESC) | Raw DB order |
| Oldest | Oldest classified first (`moderated_at` ASC) | Reverse of DB order |

Default: "By score" (preserves current behavior).

### UI

- Dropdown styled to match the existing "since" filter
- Label format: "Sort: By score" / "Sort: Newest" / "Sort: Oldest"
- Placed immediately left of or right of the existing "since" dropdown
- Selection applies immediately (re-sorts current queue, no re-fetch)
- Sort preference resets on page reload (no persistence needed)

### Scope

- Frontend-only change in `src/admin/swipe-review.html`
- Sorting applies to the AI-flagged portion of the queue only
- Untriaged tail ordering unchanged (appended after flagged items)
- No backend changes needed -- `moderated_at` and `scores` are already in the response

## Follow-up (separate issue)

- Filter to exclude test videos from non-Divine users in the quick review queue
