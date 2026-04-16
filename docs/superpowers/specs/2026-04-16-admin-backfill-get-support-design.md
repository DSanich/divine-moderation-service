# Admin Backfill GET Support Design

## Summary

Moderators are using the browser address bar to trigger review-context backfills. The current admin endpoint only accepts `POST`, so a direct browser visit falls through to the API index and does nothing. This design makes `/admin/api/backfill-review-context` accept both `GET` and `POST` while keeping the existing auth checks, limit handling, JSON response shape, and backfill logic intact.

## Goals

- Let authenticated admins trigger review-context backfills with a browser `GET`.
- Keep existing `POST` callers working without behavior changes.
- Reuse one backfill implementation path so `GET` and `POST` cannot drift.
- Preserve JSON responses for easy scripting and browser inspection.

## Non-Goals

- Changing auth requirements for the endpoint.
- Adding a separate UI page or button for backfill.
- Changing the backfill scan, repair, or persistence logic.

## Proposed Design

### Route Behavior

`/admin/api/backfill-review-context` should accept both `GET` and `POST`.

For either method:

- require the existing admin auth
- parse `limit` from the query string
- cap `limit` the same way as today
- execute the existing backfill scan and repair behavior
- return the same JSON payload shape:
  - `scanned`
  - `repaired`
  - `skipped`
  - `repairs`

### Shared Implementation

Extract the current route body into one helper that both methods call. The route matcher should change from `request.method === 'POST'` to allowing `GET` and `POST`, but the actual work should still live in one place.

### HTTP Semantics Tradeoff

`GET` becomes a state-changing admin action. That is not ideal in generic public APIs, but it is acceptable here because:

- this is an authenticated internal admin endpoint
- the user workflow is explicit and intentional
- supporting the browser address bar is the point of the change

## Testing Strategy

Add regression coverage proving:

- `GET /admin/api/backfill-review-context?limit=N` succeeds for an authenticated admin
- `GET` returns the same repair result shape as `POST`
- repaired rows are persisted through the same code path
