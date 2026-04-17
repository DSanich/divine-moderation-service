# Classic Vine Age Restriction Downgrade Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover legacy Vine archive videos with stale machine-applied moderation and downgrade eligible non-`SAFE` rows to `AGE_RESTRICTED` without touching human-reviewed items.

**Architecture:** Implement a standalone operational script with preview and execute modes. Reuse relay discovery patterns and the existing moderation API, but keep filtering logic local and conservative.

**Tech Stack:** Node.js ESM scripts, Vitest, relay WebSocket queries, moderation API

---

### Task 1: Add Failing Script Tests

**Files:**
- Create: `scripts/downgrade-classic-vines-to-age-restricted.test.mjs`
- Create: `scripts/downgrade-classic-vines-to-age-restricted.mjs`

- [ ] **Step 1: Write the failing tests**

Cover:
- classic Vine event discovery by `x` / `imeta x`
- skip rows with `reviewed_by`
- skip rows with `review_notes`
- accept machine-applied non-`SAFE` rows

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/downgrade-classic-vines-to-age-restricted.test.mjs`

Expected: FAIL because the script helpers do not exist yet.

### Task 2: Implement Discovery And Eligibility Helpers

**Files:**
- Modify: `scripts/downgrade-classic-vines-to-age-restricted.mjs`

- [ ] **Step 1: Write minimal implementation**

Export pure helpers for:
- config parsing
- legacy Vine detection
- moderation-row eligibility filtering
- API request building

- [ ] **Step 2: Run tests**

Run: `npx vitest run scripts/downgrade-classic-vines-to-age-restricted.test.mjs`

Expected: PASS

### Task 3: Implement Script Execution Flow

**Files:**
- Modify: `scripts/downgrade-classic-vines-to-age-restricted.mjs`

- [ ] **Step 1: Add preview/execute flow**

Implement:
- relay pagination
- moderation decision lookups
- checkpoint/report writing
- `AGE_RESTRICTED` update calls via `/api/v1/moderate`

- [ ] **Step 2: Run focused verification**

Run: `npx vitest run scripts/downgrade-classic-vines-to-age-restricted.test.mjs src/nostr/relay-client.test.mjs src/moderation/classic-vine-rollback.test.mjs`

Expected: PASS
