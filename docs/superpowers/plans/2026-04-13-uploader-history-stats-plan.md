# Uploader History & Stats for Admin Dashboard

Date: 2026-04-13
Branch: worktree-agent-a7e8279a

## Problem

Human moderators reviewing a flagged video see zero context about the
uploader. They can't tell a first-time poster from a repeat offender, which
makes per-video calls harder and inconsistent.

## Prior-art: commit e9179dc ("remove dead code tracking and uploader stats surface")

That commit (on another branch, not merged here) deleted:

- `src/offender-tracker.mjs` (109 lines) + tests (157 lines): maintained a
  denormalized `uploader_stats` D1 table (total_scanned, flagged_count,
  restricted_count, banned_count, review_count, last_flagged_at,
  risk_level) written on every moderation result.
- `getUploaderStats` call in `enrichAdminLookupVideo` and the
  `uploaderStats` field on lookup responses.
- The `updateUploaderStats` call inside the queue consumer.
- The `stats.risk_level` / `flagged` / `restricted` / `banned` badge bits
  in `createUploaderEnforcementPanel`.

Commit message says it was removed because the system "no longer implies
repeat-offender tracking is operational" — i.e. the feature was stale,
wasn't meaningfully surfaced in the UI, and the denormalized aggregate
table drifted / became untrustworthy.

### Lesson → constraints for this task

1. **No new aggregate table.** Query `moderation_results` directly with
   `GROUP BY action` / `COUNT(*)` on demand. The source of truth is the
   raw results table. No write-side bookkeeping = no drift.
2. **No `risk_level` heuristic.** Surface raw counts (uploads, REVIEW,
   QUARANTINE, AGE_RESTRICTED, PERMANENT_BAN, DMs) and let the human
   moderator judge. Don't invent a "high/elevated/low" label that will
   silently go stale or be wrong.
3. **Must be visibly surfaced.** The prior version was "implied but not
   operational" — this one lives in the video card where moderators
   actually look during triage, with a lazy fetch from a dedicated
   endpoint so it's obvious when it's wrong.

## Scope

1. Add `GET /admin/api/uploader/:pubkey` returning on-demand aggregates
   computed from `moderation_results` + `dm_log` + `uploader_enforcement`.
2. Extend the existing `createUploaderEnforcementPanel` (or a sibling
   panel rendered right after it) in `src/admin/dashboard.html` to
   lazy-fetch and display the uploader summary on both `createVideoCard`
   and `createTriageCard`.

### Out of scope

- Do NOT touch admin video proxy / playback.
- Do NOT touch identity block / event-meta / lookup grid width (another
  agent owns that).
- Do NOT resurrect `offender-tracker.mjs` or the `uploader_stats` table.
- No PR / no merge; commit on worktree branch only.

## Endpoint shape

`GET /admin/api/uploader/:pubkey` (requires Zero Trust JWT via
`requireAuth`):

```json
{
  "pubkey": "abc123...",
  "profile": { "name": "alice", "display_name": "Alice", "picture": "...", "nip05": "..." } | null,
  "totals": {
    "videos": 47,
    "firstSeen": "2026-01-03T12:00:00.000Z",
    "lastSeen": "2026-04-12T08:22:00.000Z"
  },
  "actionBreakdown": {
    "SAFE": 40,
    "REVIEW": 3,
    "QUARANTINE": 2,
    "AGE_RESTRICTED": 1,
    "PERMANENT_BAN": 1
  },
  "recentFlagged": [
    { "sha256": "...", "action": "REVIEW", "processedAt": "2026-04-11T...", "reason": "nudity" }
  ],
  "aiFlaggedCount": 2,
  "dmCount": 5,
  "enforcement": { "approval_required": false, "relay_banned": false, "notes": null } | null
}
```

Implementation notes:

- Counts come from `SELECT action, COUNT(*) FROM moderation_results WHERE uploaded_by = ? GROUP BY action`.
- firstSeen/lastSeen: `MIN(moderated_at)`, `MAX(moderated_at)` for that pubkey.
- recentFlagged: `SELECT sha256, action, moderated_at, review_notes, raw_response FROM moderation_results WHERE uploaded_by = ? AND action IN ('REVIEW','QUARANTINE','AGE_RESTRICTED','PERMANENT_BAN') ORDER BY moderated_at DESC LIMIT 10`. `reason` is derived from `review_notes` or parsed out of `raw_response.reason`.
- aiFlaggedCount: rows where `raw_response` JSON mentions `ai_generated` or `deepfake` category (approx — or categories JSON contains those strings).
- dmCount: `SELECT COUNT(*) FROM dm_log WHERE sender_pubkey = ? OR recipient_pubkey = ?`.
- enforcement: reuse `getUploaderEnforcement(env.BLOSSOM_DB, pubkey)` — returns `null` when no row exists.
- profile: try `resolveProfile(pubkey, env)` with a try/catch — degrade gracefully to `null` on any error (relay/WebSocket mocking is painful in tests and offline).
- Empty history: return all zeros / nulls, HTTP 200 — do not 404.

## UI changes (`src/admin/dashboard.html`)

- Extend `createUploaderEnforcementPanel` (or add a sibling helper
  `createUploaderHistoryPanel`) that renders below the existing
  enforcement block inside both `createVideoCard` and `createTriageCard`.
- On card render, if `video.uploaded_by` is present, kick off a
  non-blocking `fetch('/admin/api/uploader/' + pubkey)` keyed in a
  session-level in-memory cache (`window.__uploaderHistoryCache`) so we
  only hit the endpoint once per pubkey per page load.
- Render small badges: `<N> uploads · <R> REVIEW · <Q> QUARANTINE · <B> BAN · <D> DMs`.
  Hide zero-valued badges except uploads.
- Surface `approval_required` / `relay_banned` as colored chips if true
  (these also come from the endpoint, so the panel works standalone
  even if the card didn't already hydrate enforcement from the lookup).
- Expandable list of `recentFlagged` (collapsed by default, toggle via
  existing `expanded` pattern used elsewhere in the dashboard) showing
  `action · short-sha · processedAt · reason`.

### Do-not-touch guards

- Must render BELOW the identity / event-meta area (another agent owns
  that). Plan reviewers: grep for "identity" inside `createVideoCard`
  and make sure this panel is inserted *after* that div.

## Tests (TDD — write first, must fail before implementation)

Location: extend `src/uploader-enforcement.test.mjs` (already has the
`worker.fetch`-style admin route tests and `createDbMock` scaffold) —
this keeps the test surface colocated with the other admin-route tests.
Alternative: a new `src/uploader-history.test.mjs` if the enforcement
file gets too busy.

1. `returns per-uploader aggregates from /admin/api/uploader/:pubkey`
   - Seed 5 rows in mock `moderationResults` for the same pubkey:
     3 SAFE, 1 REVIEW, 1 PERMANENT_BAN (plus one row for a *different*
     pubkey that must NOT be counted).
   - Seed 2 `dm_log` rows.
   - Seed one `uploader_enforcement` row with `approval_required = true`.
   - Assert response.actionBreakdown === {SAFE:3, REVIEW:1, QUARANTINE:0, AGE_RESTRICTED:0, PERMANENT_BAN:1}.
   - Assert totals.videos === 5, firstSeen/lastSeen populated.
   - Assert dmCount === 2, enforcement.approval_required === true.

2. `returns zero-value response for an unknown uploader`
   - Empty mock DB. Expect 200 with `totals.videos === 0`,
     `actionBreakdown` all zeros, `recentFlagged: []`, `enforcement: null`.

3. `requires Zero Trust auth`
   - Omit `Cf-Access-Authenticated-User-Email` header, set
     `ALLOW_DEV_ACCESS: 'false'`. Expect 401.

4. `action breakdown matches inserted rows exactly`
   - Seed one row of each action value (including AGE_RESTRICTED and
     QUARANTINE). Assert each count === 1.

(Implicitly this also exercises "recent flagged list is populated when
flagged rows exist".)

## Implementation steps

1. Write failing tests in `src/uploader-enforcement.test.mjs` (or new
   file). Run `npm test -- uploader-enforcement` → red.
2. Extend `createDbMock` to support `SELECT action, COUNT(*) ... GROUP BY action`,
   `SELECT MIN/MAX(moderated_at)`, `SELECT ... ORDER BY moderated_at DESC LIMIT`,
   and `SELECT COUNT(*) FROM dm_log WHERE sender_pubkey = ? OR recipient_pubkey = ?`.
3. Add handler block in `src/index.mjs` next to the other
   `/admin/api/uploader/:pubkey/...` routes.
4. Add UI panel + lazy fetch in `src/admin/dashboard.html` (`createUploaderEnforcementPanel`
   area + both card builders).
5. Run `npm test` full — baseline has 2 pre-existing failures in
   `pipeline.test.mjs` (vine classic-rollback policy), my changes must
   not regress anything else.
6. Commit on `worktree-agent-a7e8279a`.

## Risk / mitigation

- Profile resolution uses a live WebSocket → relay. Tests will mock
  `MODERATION_KV.get` to return `null` and we won't have a relay, so
  the resolver will time out (5s). **Mitigation:** inside the handler,
  fire `resolveProfile` with `Promise.race` against a 250ms timeout
  when `env.ALLOW_DEV_ACCESS !== 'false'` OR skip it when
  `env.SKIP_PROFILE_RESOLUTION === 'true'`. Simpler: always `.catch(() => null)` and set a hard `setTimeout`-based race so tests never wait 5s.
- Raw-response JSON size: only parse when extracting `reason` — keep
  `recentFlagged` limited to 10.
