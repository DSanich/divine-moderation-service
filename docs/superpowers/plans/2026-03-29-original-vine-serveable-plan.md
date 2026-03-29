# Original Vine Serveable Override Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep original Vine imports publicly serveable while preserving non-AI moderation signals and retaining AI scores for training/debugging.

**Architecture:** Resolve Vine context independently from the video URL, then split moderation output into two layers: enforcement (`action`) and downstream moderation signals (`downstreamSignals`). Original Vines force enforcement to `SAFE`, but filtered downstream signals continue to drive labels and reporting.

**Tech Stack:** Cloudflare Workers, Vitest, D1, KV, Nostr publishing, ATProto webhook integration, ESM modules

---

## File Map

- Modify: `src/moderation/pipeline.mjs`
  Responsible for always resolving Nostr context, applying original-Vine policy metadata, and deriving downstream signals.
- Modify: `src/nostr/relay-client.mjs`
  Responsible for tightening original-Vine detection priority without removing backward-compatible fallback behavior.
- Modify: `src/atproto/label-webhook.mjs`
  Responsible for building webhook payloads from derived downstream signals instead of action-only gating.
- Modify: `src/index.mjs`
  Responsible for using enforcement `action` for Blossom/public serving while using downstream signals for publishing and labels.
- Modify: `src/moderation/pipeline.test.mjs`
  Responsible for regression tests covering imported Vine behavior and downstream signal generation.
- Modify: `src/nostr/relay-client.test.mjs`
  Responsible for tests around original-Vine detection heuristics.
- Modify: `src/atproto/label-webhook.test.mjs`
  Responsible for tests covering SAFE-with-signals behavior.

## Chunk 1: Pipeline Policy Split

### Task 1: Add a failing pipeline regression test for imported original Vines

**Files:**
- Modify: `src/moderation/pipeline.test.mjs`
- Test: `src/moderation/pipeline.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('keeps imported original vines SAFE while retaining raw AI scores', async () => {
  // Mock Nostr lookup + moderation results
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/moderation/pipeline.test.mjs`
Expected: FAIL because imported videos with `metadata.videoUrl` do not yet resolve Vine context or derive override metadata.

- [ ] **Step 3: Write minimal implementation**

```js
// In moderateVideo():
// - fetch Nostr context even when metadata.videoUrl exists
// - derive originalVine policy metadata
// - preserve scores but override enforcement action to SAFE
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/moderation/pipeline.test.mjs`
Expected: PASS for the new regression test.

- [ ] **Step 5: Commit**

```bash
git add src/moderation/pipeline.mjs src/moderation/pipeline.test.mjs
git commit -m "fix: keep original vine imports serveable"
```

### Task 2: Add a failing pipeline regression test for SAFE-with-signals

**Files:**
- Modify: `src/moderation/pipeline.test.mjs`
- Test: `src/moderation/pipeline.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('emits downstream moderation signals for original vines with non-AI flags', async () => {
  // Assert SAFE action + publishable nudity/violence/gore signals
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/moderation/pipeline.test.mjs`
Expected: FAIL because downstream signal derivation does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
result.downstreamSignals = {
  scores: filteredScores,
  hasSignals: true,
  primaryConcern: derivedPrimaryConcern
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/moderation/pipeline.test.mjs`
Expected: PASS for the new downstream-signal regression.

- [ ] **Step 5: Commit**

```bash
git add src/moderation/pipeline.mjs src/moderation/pipeline.test.mjs
git commit -m "feat: derive downstream moderation signals for original vines"
```

## Chunk 2: Detection and Publishing Paths

### Task 3: Add failing tests for original-Vine detection priority

**Files:**
- Modify: `src/nostr/relay-client.test.mjs`
- Modify: `src/nostr/relay-client.mjs`
- Test: `src/nostr/relay-client.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('prefers explicit vine markers over weak timestamp inference', () => {
  // Assert explicit marker path and fallback path behavior
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/nostr/relay-client.test.mjs`
Expected: FAIL because the current helper does not expose the intended priority clearly enough.

- [ ] **Step 3: Write minimal implementation**

```js
// Separate strong Vine indicators from weak time-based fallback
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/nostr/relay-client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/nostr/relay-client.mjs src/nostr/relay-client.test.mjs
git commit -m "test: document original vine detection priority"
```

### Task 4: Add failing tests for SAFE ATProto payloads with downstream signals

**Files:**
- Modify: `src/atproto/label-webhook.test.mjs`
- Modify: `src/atproto/label-webhook.mjs`
- Test: `src/atproto/label-webhook.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('builds a webhook payload from downstream signals even when action is SAFE', () => {
  // Assert labels come from downstreamSignals.scores
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/atproto/label-webhook.test.mjs`
Expected: FAIL because SAFE currently returns null unconditionally.

- [ ] **Step 3: Write minimal implementation**

```js
const signalScores = result.downstreamSignals?.scores || result.scores || {};
const shouldPublish = result.downstreamSignals?.hasSignals || result.action !== 'SAFE';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/atproto/label-webhook.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/atproto/label-webhook.mjs src/atproto/label-webhook.test.mjs
git commit -m "feat: publish atproto signals for serveable original vines"
```

## Chunk 3: Worker Integration

### Task 5: Add a failing integration-style test for downstream publishing behavior

**Files:**
- Modify: `src/index.test.mjs`
- Modify: `src/index.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
it('keeps original vines serveable while still publishing downstream moderation signals', async () => {
  // Assert Blossom receives SAFE semantics while label/report hooks receive filtered signals
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs`
Expected: FAIL because publishing is still gated by `action !== 'SAFE'`.

- [ ] **Step 3: Write minimal implementation**

```js
// In handleModerationResult():
// - keep Blossom driven by action
// - build report/label payloads from downstreamSignals
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs src/moderation/label-writer.mjs
git commit -m "fix: separate serveability from moderation signal publishing"
```

### Task 6: Run targeted and full verification

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/moderation/pipeline.mjs`
- Modify: `src/atproto/label-webhook.mjs`
- Modify: `src/nostr/relay-client.mjs`

- [ ] **Step 1: Run focused tests**

Run: `npx vitest run src/moderation/pipeline.test.mjs src/nostr/relay-client.test.mjs src/atproto/label-webhook.test.mjs src/index.test.mjs`
Expected: PASS

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Review user-facing behavior**

Run: `git diff -- src/moderation/pipeline.mjs src/index.mjs src/atproto/label-webhook.mjs src/nostr/relay-client.mjs`
Expected: Enforcement remains `SAFE` for original Vines while downstream signals stay intact.

- [ ] **Step 4: Commit**

```bash
git add src/moderation/pipeline.mjs src/moderation/pipeline.test.mjs src/nostr/relay-client.mjs src/nostr/relay-client.test.mjs src/atproto/label-webhook.mjs src/atproto/label-webhook.test.mjs src/index.mjs src/index.test.mjs
git commit -m "fix: keep original vines serveable without losing moderation signals"
```
