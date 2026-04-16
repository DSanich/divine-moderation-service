# Admin Backfill GET Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow authenticated admins to trigger review-context backfills with either `GET` or `POST` on the existing admin endpoint.

**Architecture:** Keep one backfill implementation path in the worker and widen the route matcher to accept both methods. Reuse the current auth, limit parsing, repair loop, and JSON response so browser-triggered `GET` behaves the same as script-triggered `POST`.

**Tech Stack:** Cloudflare Worker, D1, vanilla admin API routes, Vitest

---

## File Map

- Modify: `src/index.mjs`
  - Reuse one shared handler for `GET` and `POST` on `/admin/api/backfill-review-context`.
- Modify: `src/index.test.mjs`
  - Add regression coverage proving authenticated `GET` runs the same repair path as `POST`.

## Chunk 1: GET Route Support

### Task 1: Add failing coverage for authenticated GET backfill

**Files:**
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test for `GET /admin/api/backfill-review-context?limit=10` that uses the same sparse-row fixture as the current `POST` test and asserts the repair result and persisted D1 fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "backfill review context"`
Expected: FAIL because the route only accepts `POST`.

- [ ] **Step 3: Write minimal implementation**

Update `src/index.mjs` so `/admin/api/backfill-review-context` accepts both `GET` and `POST` and routes both methods through one shared implementation block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.mjs -t "backfill review context"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs docs/superpowers/specs/2026-04-16-admin-backfill-get-support-design.md docs/superpowers/plans/2026-04-16-admin-backfill-get-support-plan.md
git commit -m "feat: allow get for admin backfill context"
```

## Chunk 2: Verification

### Task 2: Verify the route change

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Run focused verification**

Run: `npm test -- src/index.test.mjs -t "backfill review context"`
Expected: PASS

- [ ] **Step 2: Run full file verification**

Run: `npm test -- src/index.test.mjs`
Expected: PASS
