# Admin Playback Bypass Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every moderation UI video player use the authenticated admin proxy so moderators can watch blocked media.

**Architecture:** Keep the existing `/admin/video/:sha.mp4` backend route as the single playback path. Update admin UI playback URL builders to always point at that route, and add regression tests that lock in both the proxy fallback behavior and the frontend URL generation.

**Tech Stack:** Cloudflare Workers, vanilla HTML/JS admin pages, Vitest

---

## Chunk 1: Docs And Safety Rails

### Task 1: Record the approved design

**Files:**
- Create: `docs/superpowers/specs/2026-04-01-admin-playback-bypass-design.md`

- [ ] **Step 1: Save the approved design document**

Write the design summary, scope, non-goals, playback rule, and testing strategy.

- [ ] **Step 2: Commit the spec**

Run: `git add docs/superpowers/specs/2026-04-01-admin-playback-bypass-design.md && git commit -m "docs: add admin playback bypass design"`

Expected: commit succeeds with only the spec doc staged.

### Task 2: Save the implementation plan

**Files:**
- Create: `docs/superpowers/plans/2026-04-01-admin-playback-bypass-plan.md`

- [ ] **Step 1: Save the implementation plan**

Write the task list, exact files, tests, and commands for the bugfix.

## Chunk 2: Regression Tests First

### Task 3: Add failing tests for the admin proxy fallback

**Files:**
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write a failing test for `/admin/video/:sha.mp4` fallback**

Add a test that:
- authenticates an admin request
- makes the public CDN fetch return `404`
- makes the authenticated Blossom admin blob endpoint return `200`
- asserts the response succeeds and includes `X-Admin-Proxy: blossom-admin`

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run src/index.test.mjs -t "falls back to Blossom admin bypass when CDN video is blocked"`

Expected: FAIL because the new regression test is not satisfied yet or because fixtures do not fully model the desired behavior.

### Task 4: Add failing tests for admin playback URL generation

**Files:**
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write failing tests for dashboard and swipe-review playback URLs**

Add tests that fetch `/admin` and `/admin/review`, read the served HTML, and assert the relevant playback helpers/builders reference `/admin/video/` rather than `https://media.divine.video/` for moderation playback.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run src/index.test.mjs -t "uses the admin video proxy for moderation playback"`

Expected: FAIL while the current HTML still includes public playback URLs in moderation views.

## Chunk 3: Minimal Implementation

### Task 5: Normalize dashboard playback to the admin proxy

**Files:**
- Modify: `src/admin/dashboard.html`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Update the dashboard playback URL helpers**

Make the dashboard playback source builder always return `/admin/video/${sha256}.mp4` for rendered video elements.

- [ ] **Step 2: Keep copy/share behavior unchanged**

Do not remove `cdnUrl` or other public URLs from metadata or buttons.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run src/index.test.mjs -t "uses the admin video proxy for moderation playback"`

Expected: PASS for the dashboard assertions.

### Task 6: Normalize swipe-review playback and preload to the admin proxy

**Files:**
- Modify: `src/admin/swipe-review.html`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Update swipe-review rendered playback URLs**

Make rendered review cards use `/admin/video/${sha256}.mp4` regardless of moderation state.

- [ ] **Step 2: Update swipe-review preloading URLs**

Make preloaded video elements use the same admin proxy URL.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run src/index.test.mjs -t "uses the admin video proxy for moderation playback"`

Expected: PASS for the swipe-review assertions.

## Chunk 4: Verification

### Task 7: Verify the bugfix end-to-end in tests

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/admin/dashboard.html`
- Modify: `src/admin/swipe-review.html`

- [ ] **Step 1: Run targeted proxy and playback tests**

Run:
```bash
npx vitest run src/index.test.mjs -t "falls back to Blossom admin bypass when CDN video is blocked"
npx vitest run src/index.test.mjs -t "uses the admin video proxy for moderation playback"
```

Expected: both targeted test runs PASS.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: PASS with no regressions.

- [ ] **Step 3: Commit the implementation**

Run:
```bash
git add src/admin/dashboard.html src/admin/swipe-review.html src/index.test.mjs docs/superpowers/plans/2026-04-01-admin-playback-bypass-plan.md
git commit -m "fix: route moderation playback through admin proxy"
```

Expected: commit succeeds with the playback fix and tests.
