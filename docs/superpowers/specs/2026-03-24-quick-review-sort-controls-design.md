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

### Two Independent Controls

**Load order** (backend, re-fetches): determines which 100 items get pulled from the full queue.

| Label | Behavior | Notes |
|-------|----------|-------|
| Load: Newest first | Most recently classified from full queue | Default, current behavior |
| Load: Oldest first | Oldest classified from full queue | Backend `ORDER BY moderated_at ASC` |

**Sort order** (client-side, re-sorts loaded batch): reorders the 100 loaded items.

| Label | Behavior | Notes |
|-------|----------|-------|
| Sort: Highest score | Highest max Hive AI score first | Current default, now made visible |
| Sort: Lowest score | Lowest max Hive AI score first | |

### UI

- Two dropdowns styled to match the existing "since" filter
- Placed left of the existing "since" dropdown
- Subtitle under "Quick Review" heading: "Showing AI-flagged items awaiting review"
- Load order change triggers re-fetch; sort order change re-sorts in place
- Preferences reset on page reload (no persistence needed)

### Scope

- Frontend change in `src/admin/swipe-review.html` (two dropdowns, sort/load logic)
- Backend change in `src/index.mjs` (accept `sort=oldest` query param on `/admin/api/videos`)
- Sorting applies to the AI-flagged portion of the queue only
- Untriaged tail ordering unchanged (appended after flagged items)

## Follow-up (separate issue)

- Filter to exclude test videos from non-Divine users in the quick review queue
