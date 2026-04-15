# Relay-to-D1 Context Cache And Backfill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist relay-resolved admin review context into D1, add a repair/backfill path for historical rows, and remove internal fallback jargon from moderator-facing UI.

**Architecture:** Keep `api.divine.video` as the primary source of truth, but treat the admin worker as a read-through/write-through cache. Successful relay lookups should normalize context once, persist it into existing D1 fields, and let future admin surfaces read repaired local snapshots. UI rendering should remain neutral even when both relay and D1 are thin.

**Tech Stack:** Cloudflare Worker, D1, fetch-based REST integration to `api.divine.video`, vanilla HTML/JS admin UI, Vitest

---

## File Map

- Modify: `src/index.mjs`
  - Add persistence helpers for relay-resolved context.
  - Reuse one normalization path for live lookup and backfill repair.
  - Add a backfill entry point for sparse moderation rows.
- Modify: `src/index.test.mjs`
  - Add regression coverage for write-through caching, backfill repair, and neutral UI copy.
- Modify: `src/admin/swipe-review.html`
  - Remove internal fallback copy from card and creator modal empty states.

## Chunk 1: Relay Lookup Writes Back To D1

### Task 1: Add a failing test for write-through caching during admin lookup

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/index.mjs`

- [ ] **Step 1: Write the failing test**

Add a test for `GET /admin/api/video/{identifier}` where:
- the moderated row is missing core metadata
- relay/API returns valid post + creator context

Assert that the response contains the relay data and that the mocked D1 write path updates the local row with repaired fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: FAIL because current lookup enriches the payload but does not persist the repaired context.

- [ ] **Step 3: Write minimal implementation**

In `src/index.mjs`:
- add a helper that normalizes relay context into the local D1 shape
- persist repaired fields into `moderation_results` when relay lookup succeeds
- reuse the helper from the existing admin lookup flow

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: cache relay review context in d1"
```

## Chunk 2: Historical Backfill Repair

### Task 2: Add a failing test for repairing sparse historical rows

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/index.mjs`

- [ ] **Step 1: Write the failing test**

Add a test for a backfill/repair path that:
- selects rows missing `event_id`, `uploaded_by`, and title
- resolves one row through relay/API
- updates only the recoverable row in D1

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "relay context backfill|admin context repair"`
Expected: FAIL because no shared repair path exists yet.

- [ ] **Step 3: Write minimal implementation**

Add a small repair entry point in `src/index.mjs` that:
- scans sparse rows
- resolves relay context with the same helper used by live lookup
- persists repaired rows
- skips unresolved rows without inventing placeholder data

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "relay context backfill|admin context repair"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: backfill sparse review context from relay"
```

## Chunk 3: Neutral Moderator UI

### Task 3: Add a failing UI test for moderator-facing empty states

**Files:**
- Modify: `src/admin/swipe-review.html`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test that renders Quick Review empty-state metadata and creator info for a row with no resolved relay context.

Assert the HTML does not contain:
- `Legacy moderation row`
- `legacy_moderation_row_without_context`
- `Unknown provenance`
- `Unknown Creator`

Assert it does contain neutral moderator-facing copy.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "Quick review HTML|Creator info"`
Expected: FAIL because the current UI still leaks internal fallback language.

- [ ] **Step 3: Write minimal implementation**

Update `src/admin/swipe-review.html` so:
- card metadata uses neutral empty-state labels
- creator modal uses neutral unavailable copy
- internal fallback fields are not rendered

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "Quick review HTML|Creator info"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/swipe-review.html src/index.test.mjs
git commit -m "fix: hide internal fallback state from quick review"
```

## Chunk 4: Verification

### Task 4: Run verification

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`
- Modify: `src/admin/swipe-review.html`

- [ ] **Step 1: Run focused verification**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup|relay context backfill|Quick review HTML|Creator info"`
Expected: PASS

- [ ] **Step 2: Run full file verification**

Run: `npm test -- src/index.test.mjs`
Expected: PASS

- [ ] **Step 3: Run supporting relay client verification**

Run: `npm test -- src/nostr/relay-client.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit final integration changes**

```bash
git add src/index.mjs src/index.test.mjs src/admin/swipe-review.html docs/superpowers/specs/2026-04-16-relay-d1-cache-backfill-design.md docs/superpowers/plans/2026-04-16-relay-d1-cache-backfill-plan.md
git commit -m "feat: cache and backfill relay review context"
```
