# Quick Review Metadata-First Card Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the quick review card show full publisher, post, timeline, and technical metadata by default so moderators can decide without opening another page.

**Architecture:** Extend the quick review queue API to return persisted post metadata on first load, then refactor the card renderer in `src/admin/swipe-review.html` into a wider metadata-first layout that merges queue payload fields with async lookup enrichment. Keep existing async enrichment for missing or deeper lookup data, but make the initial card materially complete before any follow-up fetch resolves.

**Tech Stack:** Cloudflare Worker, D1, vanilla HTML/CSS/JS, Vitest

---

## File Map

- Modify: `src/index.mjs`
  - Extend `/admin/api/videos` rows and JSON shaping to include persisted metadata fields needed by the quick review card.
  - Extend admin lookup helpers so richer Nostr metadata is preserved in the card enrichment payload.
- Modify: `src/admin/swipe-review.html`
  - Refactor the card layout, rendering helpers, and metadata formatting for the metadata-first review card.
- Modify: `src/index.test.mjs`
  - Add failing coverage for quick review API metadata fields and enriched admin lookup payload behavior.

## Chunk 1: API Payload And Lookup Enrichment

### Task 1: Add a failing queue payload test

**Files:**
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add an admin quick review API test that seeds a `moderation_results` row with:
- `title`
- `author`
- `event_id`
- `content_url`
- `published_at`

Assert `GET /admin/api/videos?action=FLAGGED&limit=100` returns those fields in `body.videos[0]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs`
Expected: FAIL because `/admin/api/videos` does not currently select/return the persisted metadata fields.

- [ ] **Step 3: Write minimal implementation**

Update the `/admin/api/videos` SQL query and JSON shaping in `src/index.mjs` to include:
- `title`
- `author`
- `event_id`
- `content_url`
- `published_at`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs`
Expected: PASS for the new quick review API test.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: expose quick review metadata fields"
```

### Task 2: Add a failing lookup enrichment test

**Files:**
- Test: `src/index.test.mjs`
- Modify: `src/index.mjs`

- [ ] **Step 1: Write the failing test**

Add or extend an admin video lookup test to verify the response can carry rich `nostrContext` fields used by the card:
- `content`
- `sourceUrl`
- `platform`
- `client`
- `loops`
- `likes`
- `comments`
- `publishedAt`
- `archivedAt`
- `importedAt`
- `vineHashId`
- `vineUserId`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs`
Expected: FAIL because the current moderation-row-backed lookup response does not preserve enough stored metadata for the card.

- [ ] **Step 3: Write minimal implementation**

Update lookup shaping in `src/index.mjs` so admin lookup responses preserve stored metadata and merge richer event metadata when available without dropping persisted values.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs`
Expected: PASS for the new/updated lookup enrichment assertions.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: preserve rich admin lookup metadata"
```

## Chunk 2: Metadata-First Review Card

### Task 3: Add a failing card-render test

**Files:**
- Test: `src/index.test.mjs`
- Modify: `src/admin/swipe-review.html`

- [ ] **Step 1: Write the failing test**

Add an HTML response test for `/admin/review` that asserts the quick review page contains the new renderer markers/helper names for:
- publisher identity section
- timeline section
- metadata grid
- full-content/post block

This test should be structural rather than screenshot-based.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs`
Expected: FAIL because the current HTML does not include the new metadata-first structure.

- [ ] **Step 3: Write minimal implementation**

Refactor `src/admin/swipe-review.html` to:
- widen the card and add a desktop two-column layout
- render all visible metadata sections by default
- show labeled timestamps for `Published`, `Received`, `Moderated`, and `Reviewed`
- show full pubkey, post text, title, links, IDs, and technical metadata
- keep classifier, transcript, scores, and actions visible below the post context

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs`
Expected: PASS for the new HTML structure assertions.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/admin/swipe-review.html src/index.test.mjs
git commit -m "feat: redesign quick review card around metadata"
```

### Task 4: Verify merged payload behavior end to end

**Files:**
- Modify: `src/admin/swipe-review.html`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a targeted test that verifies queue metadata and lookup enrichment can coexist without clobbering the visible fields the card depends on.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs`
Expected: FAIL if the merge logic still favors sparse async lookup data over richer persisted queue fields.

- [ ] **Step 3: Write minimal implementation**

Adjust the client-side merge/render helpers in `src/admin/swipe-review.html` so:
- queue payload fields render immediately
- async lookup fills missing values and richer metadata
- existing values are not overwritten by emptier lookup fields

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs`
Expected: PASS for the merge/fallback assertions.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/admin/swipe-review.html src/index.test.mjs
git commit -m "fix: preserve quick review metadata during enrichment"
```

## Chunk 3: Verification

### Task 5: Run targeted and full verification

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/admin/swipe-review.html`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- src/index.test.mjs`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Review the rendered quick review HTML for obvious regressions**

Check:
- card width and responsive layout classes
- no hidden/collapsed metadata sections
- action buttons still present
- sanitization helpers still wrap user-provided strings

- [ ] **Step 4: Commit final integration changes**

Run:
```bash
git add src/index.mjs src/admin/swipe-review.html src/index.test.mjs
git commit -m "feat: show full quick review context by default"
```
