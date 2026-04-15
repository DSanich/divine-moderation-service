# Relay-First Admin Review Context Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Quick Review and admin video lookup use `api.divine.video` as the primary source of post and publisher context, with admin/D1 only as fallback for deleted or missing content.

**Architecture:** Add relay-first enrichment helpers in `src/index.mjs` that resolve video context from relay REST using stable identifiers, normalize the response into the admin payload shape, and merge it ahead of local fallback metadata. Keep moderation state local, but stop using thin local rows and raw websocket lookups as the default post-context source.

**Tech Stack:** Cloudflare Worker, fetch-based REST integration, D1 fallback queries, vanilla HTML/JS admin UI, Vitest

---

## File Map

- Modify: `src/index.mjs`
  - Add relay-first admin review context fetch helpers.
  - Update admin lookup shaping to prefer relay/API context over D1.
  - Keep D1/admin fallback for deleted or unreachable content.
- Modify: `src/index.test.mjs`
  - Add regression coverage for relay-first admin lookup and fallback behavior.
- Modify: `src/admin/swipe-review.html`
  - Only if needed to consume new response fields or adjust merge order.

## Chunk 1: Relay-First Lookup Helpers

### Task 1: Add a failing admin lookup test for relay-first context

**Files:**
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test for `GET /admin/api/video/{identifier}` where:
- D1 has a moderated row
- relay/API returns rich post context

Assert the response prefers relay/API values for:
- title
- content
- event id / stable link
- author name
- publisher context

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: FAIL because current lookup still depends on local rows and websocket enrichment.

- [ ] **Step 3: Write minimal implementation**

In `src/index.mjs`:
- add a relay/API fetch helper for single-video admin context
- normalize the relay response into the admin lookup payload shape
- merge relay fields before local fallback fields

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: use relay context for admin video lookup"
```

### Task 2: Add a failing fallback test for deleted or missing relay content

**Files:**
- Test: `src/index.test.mjs`
- Modify: `src/index.mjs`

- [ ] **Step 1: Write the failing test**

Add a test where relay/API returns `404` or an upstream error while D1 contains fallback metadata.

Assert the admin lookup still returns:
- moderation state
- stored title/author/link fields
- uploader pubkey when available

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: FAIL because the current merge path is not explicitly relay-first with local fallback semantics.

- [ ] **Step 3: Write minimal implementation**

Update the lookup helpers so:
- relay/API is attempted first
- `404` and transport failures fall back to local admin/D1 metadata
- deleted/missing content still yields a useful moderation payload

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "fix: fall back to admin metadata when relay lookup misses"
```

## Chunk 2: Publisher Hydration

### Task 3: Add a failing test for publisher context preference

**Files:**
- Test: `src/index.test.mjs`
- Modify: `src/index.mjs`

- [ ] **Step 1: Write the failing test**

Add a test where relay/API returns richer publisher information than the local row.

Assert the admin lookup prefers relay/API publisher fields over:
- `Unknown publisher`
- truncated or missing author info
- empty profile context

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: FAIL because current publisher enrichment is built around the local row plus websocket profile lookup.

- [ ] **Step 3: Write minimal implementation**

Update the enrichment path to use relay/API publisher context first and only use local placeholders when upstream data is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: prefer relay publisher context in admin review"
```

## Chunk 3: Quick Review Merge Safety

### Task 4: Add a failing UI merge test if the client still clobbers good data

**Files:**
- Modify: `src/admin/swipe-review.html`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

If the page merge logic can overwrite good relay/API fields with sparse local values, add a targeted HTML/behavior test for that merge order.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs`
Expected: FAIL if client merge order is still wrong.

- [ ] **Step 3: Write minimal implementation**

Adjust the review page merge helper so:
- relay/API-enriched fields win
- local fallback only fills gaps

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/swipe-review.html src/index.test.mjs
git commit -m "fix: preserve relay context in quick review merge"
```

## Chunk 4: Verification

### Task 5: Run verification

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`
- Modify: `src/admin/swipe-review.html` (if touched)

- [ ] **Step 1: Run focused verification**

Run: `npm test -- src/index.test.mjs -t "Admin video lookup|Quick review HTML"`
Expected: PASS

- [ ] **Step 2: Run full file verification**

Run: `npm test -- src/index.test.mjs`
Expected: PASS

- [ ] **Step 3: Commit final integration changes**

```bash
git add src/index.mjs src/index.test.mjs src/admin/swipe-review.html docs/superpowers/specs/2026-04-14-relay-first-admin-review-context-design.md docs/superpowers/plans/2026-04-14-relay-first-admin-review-context-plan.md
git commit -m "feat: use relay-first context in admin review"
```
