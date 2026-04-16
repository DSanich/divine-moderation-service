# Relay Replica Backfill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror authoritative `api.divine.video` video and creator context into D1, switch admin lookup to a read-through/write-through replica model, and provide a resumable local backfill for the historical moderation corpus.

**Architecture:** Add dedicated D1 mirror tables for videos and creators, normalize upstream payloads into those tables, and keep `moderation_results` as the moderation-state table with a small denormalized metadata slice. Admin lookup will serve mirrored rows when present, otherwise fetch from `api.divine.video`, persist the result, and return it. A local script will walk sparse moderation rows with a stable cursor and hydrate production D1 in resumable batches.

**Tech Stack:** Cloudflare Worker, D1, local Node.js script, `api.divine.video` REST endpoints, Vitest

---

## File Map

- Create: `migrations/00x-relay-replica.sql`
  - Add `relay_videos` and `relay_creators` mirror tables and indexes.
- Modify: `src/index.mjs`
  - Add mirror normalization, mirror upsert helpers, D1-first lookup helpers, and write-through fallback behavior.
- Modify: `src/index.test.mjs`
  - Add regression coverage for mirrored lookup, write-through refresh, and denormalized moderation updates.
- Create: `scripts/backfill-relay-replica.mjs`
  - Local resumable repair script for production D1.
- Create: `scripts/backfill-relay-replica.test.mjs`
  - Tests for cursor progression, checkpoint behavior, and repair accounting.
- Create: `tmp/` checkpoint file at runtime
  - Example: `tmp/backfill-relay-replica.checkpoint.json`

## Chunk 1: Add Mirror Schema

### Task 1: Create D1 migrations for authoritative mirror tables

**Files:**
- Create: `migrations/00x-relay-replica.sql`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing schema-oriented tests**

Add tests that assume worker lookup can read mirrored video and creator rows and that those rows expose the explicit fields the admin UI needs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "relay mirror|admin mirror lookup"`
Expected: FAIL because no mirror tables or lookup path exist yet.

- [ ] **Step 3: Add the migration**

Create a migration that adds:
- `relay_videos`
- `relay_creators`
- supporting indexes

- [ ] **Step 4: Re-run the targeted tests**

Run: `npm test -- src/index.test.mjs -t "relay mirror|admin mirror lookup"`
Expected: still FAIL, but now on missing implementation instead of missing schema assumptions.

- [ ] **Step 5: Commit**

```bash
git add migrations/00x-relay-replica.sql src/index.test.mjs
git commit -m "feat: add relay replica d1 schema"
```

## Chunk 2: Mirror Normalization And Upserts

### Task 2: Normalize upstream video and creator payloads into D1

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write failing tests for mirror upserts**

Add tests for helper functions or route-driven behavior that:
- take an upstream video payload and upsert `relay_videos`
- take an upstream creator payload and upsert `relay_creators`
- refresh denormalized columns in `moderation_results`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "relay mirror upsert|denormalized moderation refresh"`
Expected: FAIL

- [ ] **Step 3: Implement minimal normalization and upsert helpers**

In `src/index.mjs`:
- normalize video payloads into `relay_videos`
- normalize creator payloads into `relay_creators`
- refresh `moderation_results` fields from mirrored data

- [ ] **Step 4: Re-run the targeted tests**

Run: `npm test -- src/index.test.mjs -t "relay mirror upsert|denormalized moderation refresh"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: mirror relay video and creator context into d1"
```

## Chunk 3: Switch Admin Lookup To Replica + Write-Through

### Task 3: Make admin lookup use mirrored D1 first and upstream write-through second

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write failing read-path tests**

Add tests that prove:
- admin lookup serves mirrored data when available
- missing or stale mirror rows trigger an `api.divine.video` fetch
- successful upstream fetch writes through to mirrored tables and refreshes `moderation_results`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.mjs -t "admin mirror lookup|write-through relay refresh"`
Expected: FAIL

- [ ] **Step 3: Implement the lookup changes**

Update `src/index.mjs` so admin lookup:
- reads moderation state from `moderation_results`
- reads mirrored video and creator rows
- falls through to upstream fetch when mirror rows are missing, incomplete, or stale
- writes fresh upstream data back into D1
- only uses legacy scraps when upstream truly misses

- [ ] **Step 4: Re-run the targeted tests**

Run: `npm test -- src/index.test.mjs -t "admin mirror lookup|write-through relay refresh"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: use relay replica for admin lookup"
```

## Chunk 4: Build The Local Resumable Backfill Script

### Task 4: Add the production D1 backfill runner

**Files:**
- Create: `scripts/backfill-relay-replica.mjs`
- Create: `scripts/backfill-relay-replica.test.mjs`

- [ ] **Step 1: Write failing script tests**

Add tests covering:
- stable cursor progression by `moderated_at` and `sha256`
- checkpoint save/load
- batch repair accounting
- safe restart overlap behavior

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/backfill-relay-replica.test.mjs`
Expected: FAIL because the script does not exist yet.

- [ ] **Step 3: Implement the script**

The script should:
- query sparse moderation rows directly from production D1
- fetch authoritative video and creator context from `api.divine.video`
- upsert mirrored rows
- refresh denormalized moderation fields
- save a checkpoint after every batch
- stop on D1 write failures

- [ ] **Step 4: Re-run the script tests**

Run: `npm test -- scripts/backfill-relay-replica.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-relay-replica.mjs scripts/backfill-relay-replica.test.mjs
git commit -m "feat: add resumable relay replica backfill script"
```

## Chunk 5: Verification

### Task 5: Verify the integrated change set

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`
- Create: `scripts/backfill-relay-replica.mjs`
- Create: `scripts/backfill-relay-replica.test.mjs`
- Create: `migrations/00x-relay-replica.sql`

- [ ] **Step 1: Run targeted worker tests**

Run: `npm test -- src/index.test.mjs -t "relay mirror|admin mirror lookup|write-through relay refresh|denormalized moderation refresh"`
Expected: PASS

- [ ] **Step 2: Run targeted backfill tests**

Run: `npm test -- scripts/backfill-relay-replica.test.mjs`
Expected: PASS

- [ ] **Step 3: Run full admin-worker verification**

Run: `npm test -- src/index.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit final integration**

```bash
git add migrations/00x-relay-replica.sql src/index.mjs src/index.test.mjs scripts/backfill-relay-replica.mjs scripts/backfill-relay-replica.test.mjs docs/superpowers/specs/2026-04-16-relay-replica-backfill-design.md docs/superpowers/plans/2026-04-16-relay-replica-backfill-plan.md
git commit -m "feat: mirror relay context into d1 and add bulk backfill"
```
