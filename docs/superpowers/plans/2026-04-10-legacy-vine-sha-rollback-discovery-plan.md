# Legacy Vine SHA Rollback Discovery Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make classic Vine rollback discovery find legacy Vine events by blob SHA when the Nostr `d` tag is the Vine ID.

**Architecture:** Extend relay lookup with a SHA-aware event search based on `x` and `imeta x`, then switch rollback discovery to that helper. Keep the event format and moderation policy unchanged.

**Tech Stack:** Cloudflare Workers, Vitest, Nostr WebSocket relay queries, ESM modules

---

### Task 1: Add Failing Discovery Tests

**Files:**
- Modify: `src/nostr/relay-client.test.mjs`
- Modify: `src/moderation/classic-vine-rollback.test.mjs`

- [ ] **Step 1: Write the failing test**

Add coverage for a legacy Vine event whose `d` tag is a Vine ID and whose blob SHA is exposed via `x` / `imeta x`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/nostr/relay-client.test.mjs src/moderation/classic-vine-rollback.test.mjs`

Expected: FAIL because SHA-based lookup still assumes `#d = sha256`.

### Task 2: Implement SHA-Aware Relay Lookup

**Files:**
- Modify: `src/nostr/relay-client.mjs`
- Modify: `src/moderation/classic-vine-rollback.mjs`

- [ ] **Step 1: Write minimal implementation**

Add a helper that fetches candidate video events and matches the requested SHA against `x` and `imeta x`, then use it from rollback discovery.

- [ ] **Step 2: Run targeted tests**

Run: `npx vitest run src/nostr/relay-client.test.mjs src/moderation/classic-vine-rollback.test.mjs`

Expected: PASS

### Task 3: Verify No Regression In Rollback Path

**Files:**
- Test: `src/index.test.mjs`

- [ ] **Step 1: Run focused rollback tests**

Run: `npx vitest run src/index.test.mjs -t "classic vine rollback"`

Expected: PASS
