# Dashboard Uploader Identity + Nostr Event Link Plan

Date: 2026-04-13
Branch: `worktree-agent-ab0dbde8`

## Problem

`src/admin/dashboard.html` renders video moderation cards and a focused
lookup result without any uploader identity: no display name, no avatar,
no truncated pubkey, no outbound link to the Nostr event or profile.
The sibling Quick Review page (`src/admin/swipe-review.html`) already
shows this. We need to port the equivalent identity rendering to the
dashboard so moderators can see who uploaded content they are reviewing
and jump to the original Nostr event.

## Scope (this agent)

- Identity header at the top of each `createVideoCard` and
  `createTriageCard` output.
- Raw Nostr event JSON detail pane (collapsible, copy button) in the
  focused lookup view.
- Wider two-column lookup grid so the card and the detail pane fit
  side-by-side.

Explicitly **out of scope** (owned by another agent):

- Uploader stats / history.
- Any change to `createUploaderEnforcementPanel` behavior.

## Design

### Shared module: `src/admin/event-meta.mjs`

Export:

- `escapeHtml(value)` — plain-string HTML entity escape (no DOM; works
  in workerd and browser).
- `buildDivineVideoUrl(video)` — first non-empty of
  `video.divineUrl`, `divine.video/video/<eventId>`.
- `buildProfileUrl(pubkey)` — `divine.video/profile/<pubkey>` or null.
- `truncatePubkey(pubkey)` — `abcdef12…90ab` style short form.
- `pickAuthorName(video)` — best display name from nostrContext.
- `createEventMetaHTML(video)` — returns identity block HTML
  (avatar initial, author name, truncated pubkey, outbound links,
  published-at).

### Dashboard wiring

- Add `<script type="module">` import (inline script re-defines it as a
  non-module copy to keep the single-HTML-file shape — or switch the
  main script tag to `type="module"`). Simpler: inline the same helpers
  into `dashboard.html` AND import them from `event-meta.mjs` in the
  vitest tests.
- Call `createEventMetaHTML(video)` at the top of `createVideoCard`
  and `createTriageCard` video-info section.
- For the focused lookup, after rendering the card put a second child
  into `.lookup-result-grid` containing:
  - Identity summary (duplicate of `createEventMetaHTML`).
  - Collapsible raw Nostr event JSON viewer (pretty-printed, copy button).
- Change `.lookup-result-grid` template-columns to
  `minmax(420px, 1fr) minmax(400px, 1.2fr)` with a media query fallback
  to a single column on narrow viewports.

### Backend

`/admin/api/video/:sha256` already returns `nostrContext`, `eventId`,
`uploaded_by`, `divineUrl`. No code change required; we will add an
integration test that asserts these keys.

## Tests (TDD)

1. `src/admin/event-meta.test.mjs`
   - `escapeHtml` escapes `<`, `>`, `&`, `"`, `'`.
   - `buildDivineVideoUrl` prefers explicit `divineUrl`, then eventId.
   - `buildProfileUrl` returns null for missing pubkey.
   - `truncatePubkey` handles short strings and normal 64-hex.
   - `createEventMetaHTML` returns HTML containing author name, short
     pubkey, profile link, divine-video link, "Unknown" fallback when
     empty.

2. `src/index.test.mjs` (extend): a new test asserting the lookup
   response for an untriaged video includes `nostrContext`, `eventId`,
   `uploaded_by`, `divineUrl` keys (even if null). The existing
   moderated-row test already verifies these — we add the assertion for
   the webhook/UNTRIAGED branch.

## Implementation steps

1. Create `event-meta.mjs` and its tests. Confirm red.
2. Make tests pass.
3. Port helpers into `dashboard.html` (inline script copy) and add
   identity block to both card builders.
4. Extend `.lookup-result-grid` CSS to two columns and render the
   detail pane next to the focused card.
5. `npm test`.
6. Commit on worktree branch (no PR).
