# Nudity Enforcement Policy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-restricting benign nudity while preserving label/downstream signals, auto-warning sexual content, and keeping explicit pornographic content ban-eligible.

**Architecture:** Split broad nudity labeling from enforcement-grade sexual signals. Narrow Hive class normalization so benign male-coded and generic nudity classes stay in label/downstream context, while explicit sexual classes feed new enforcement categories (`sexual`, `porn`) that the classifier maps to `AGE_RESTRICTED` and `PERMANENT_BAN`.

**Tech Stack:** Cloudflare Workers, Vitest, JavaScript ESM, Hive.AI moderation provider, existing moderation pipeline/classifier stack

---

## File Structure

### Core enforcement logic

- Modify: `src/moderation/providers/hiveai/normalizer.mjs`
  - Narrow Hive nudity mapping.
  - Introduce explicit enforcement-grade categories for `sexual` and `porn`.
  - Keep benign nudity classes available for labeling/downstream signals.

- Modify: `src/moderation/classifier.mjs`
  - Remove broad `nudity` from automatic enforcement.
  - Add `sexual` => `AGE_RESTRICTED`.
  - Add `porn` => `PERMANENT_BAN`.
  - Preserve existing non-nudity moderation behavior.

- Modify: `src/moderation/vocabulary.mjs`
  - Ensure classifier categories `sexual` and `porn` emit canonical labels.

### Regression coverage

- Modify: `src/moderation/providers/hiveai/normalizer.test.mjs`
  - Cover benign male-coded nudity vs explicit sexual classes.

- Modify: `src/moderation/classifier.test.mjs`
  - Cover benign nudity => `SAFE`.
  - Cover `sexual` => `AGE_RESTRICTED`.
  - Cover `porn` => `PERMANENT_BAN`.

- Modify: `src/moderation/vocabulary.test.mjs`
  - Cover label mapping for `sexual` and `porn`.

- Modify: `src/moderation/pipeline.test.mjs`
  - Prove end-to-end `SAFE` serving plus retained downstream nudity signals for benign male/swimwear content.
  - Prove sexual content still auto-warns.

### Optional if coverage reveals a gap

- Modify: `src/moderation/downstream-publishing.test.mjs`
  - Strengthen assertions around `SAFE` plus retained nudity labels if pipeline regressions expose ambiguity.

---

## Chunk 1: Narrow Hive Signal Mapping

### Task 1: Add failing Hive normalizer tests for benign vs explicit nudity

**Files:**
- Modify: `src/moderation/providers/hiveai/normalizer.test.mjs`
- Modify: `src/moderation/providers/hiveai/normalizer.mjs`

- [ ] **Step 1: Write the failing test for benign male-coded nudity**

Add a case asserting a response containing only benign male-coded classes stays in broad `nudity` and does not create `sexual` or `porn`.

```js
it('treats male-coded swimwear and shirtless classes as label-only nudity', () => {
  const result = normalizeHiveAIResponse({
    moderation: {
      status: [{
        response: {
          output: [{
            time: 0,
            classes: [
              { class: 'yes_male_nudity', score: 0.91 },
              { class: 'yes_male_swimwear', score: 0.88 },
              { class: 'yes_male_underwear', score: 0.83 }
            ]
          }]
        }
      }]
    },
    aiDetection: null
  });

  expect(result.scores.nudity).toBe(0.91);
  expect(result.scores.sexual).toBe(0);
  expect(result.scores.porn).toBe(0);
});
```

- [ ] **Step 2: Write the failing tests for warning-grade and ban-grade explicit classes**

Add two tests:

- `yes_sexual_display` / `yes_sex_toy` => `sexual`
- `yes_sexual_activity` / `animated_explicit_sexual_content` => `porn`

```js
expect(result.scores.sexual).toBe(0.9);
expect(result.scores.porn).toBe(0.95);
```

- [ ] **Step 3: Run the targeted normalizer tests and verify failure**

Run: `npx vitest run src/moderation/providers/hiveai/normalizer.test.mjs`

Expected:
- FAIL because `sexual` and `porn` are not yet in the normalized score object
- FAIL because the existing mapping still collapses all of these classes into `nudity`

- [ ] **Step 4: Implement the minimal Hive mapping change**

In `src/moderation/providers/hiveai/normalizer.mjs`:

- keep these as broad `nudity` only:
  - `yes_male_nudity`
  - `yes_male_underwear`
  - `yes_male_swimwear`
  - `yes_female_nudity`
  - `yes_female_underwear`
  - `yes_female_swimwear`
  - `general_nsfw`
  - `general_suggestive`
  - `animated_male_nudity`
  - `animated_female_nudity`
  - `animated_suggestive`
- map warning-grade explicit classes to `sexual`:
  - `yes_sexual_display`
  - `yes_sex_toy`
- map ban-grade explicit classes to `porn`:
  - `yes_sexual_activity`
  - `animated_explicit_sexual_content`

Update the default score object so `sexual` and `porn` always exist.

- [ ] **Step 5: Run the targeted normalizer tests and verify pass**

Run: `npx vitest run src/moderation/providers/hiveai/normalizer.test.mjs`

Expected:
- PASS

- [ ] **Step 6: Commit the mapping change**

```bash
git add src/moderation/providers/hiveai/normalizer.mjs src/moderation/providers/hiveai/normalizer.test.mjs
git commit -m "fix: narrow hive nudity enforcement mapping"
```

---

## Chunk 2: Rewire Enforcement Decisions

### Task 2: Add failing classifier tests for benign nudity, sexual warnings, and porn bans

**Files:**
- Modify: `src/moderation/classifier.test.mjs`
- Modify: `src/moderation/classifier.mjs`

- [ ] **Step 1: Write the failing benign nudity classifier test**

Add a test proving broad nudity no longer auto-enforces:

```js
it('keeps benign nudity SAFE when no explicit sexual signal is present', () => {
  const result = classifyModerationResult({
    maxScores: {
      nudity: 0.92,
      sexual: 0,
      porn: 0
    }
  });

  expect(result.action).toBe('SAFE');
  expect(result.category).toBeNull();
});
```

- [ ] **Step 2: Write the failing explicit sexual classifier tests**

Add:

- `sexual: 0.85` => `AGE_RESTRICTED`
- `porn: 0.9` => `PERMANENT_BAN`

```js
expect(result.action).toBe('AGE_RESTRICTED');
expect(result.action).toBe('PERMANENT_BAN');
```

- [ ] **Step 3: Run the targeted classifier tests and verify failure**

Run: `npx vitest run src/moderation/classifier.test.mjs`

Expected:
- FAIL because `nudity` still auto-restricts
- FAIL because `sexual` and `porn` are not yet classified

- [ ] **Step 4: Implement the minimal classifier change**

In `src/moderation/classifier.mjs`:

- add default score keys for `sexual` and `porn`
- remove `nudity` from `AGE_RESTRICTED_CATEGORIES`
- add explicit handling:
  - `porn >= threshold` => `PERMANENT_BAN`
  - `sexual >= threshold` => `AGE_RESTRICTED`
- keep the existing `nudity` score for labels/downstream signals only
- update `getCategoryLabel()` for `sexual` and `porn`
- update any tests that assert the exact score-key count

Use the existing NSFW thresholds for `sexual` and `porn` to avoid introducing new environment/config plumbing in this change:

```js
sexual: {
  high: parseFloat(env.NSFW_THRESHOLD_HIGH || DEFAULT_NSFW_HIGH),
  medium: parseFloat(env.NSFW_THRESHOLD_MEDIUM || DEFAULT_NSFW_MEDIUM)
},
porn: {
  high: parseFloat(env.NSFW_THRESHOLD_HIGH || DEFAULT_NSFW_HIGH),
  medium: parseFloat(env.NSFW_THRESHOLD_MEDIUM || DEFAULT_NSFW_MEDIUM)
}
```

- [ ] **Step 5: Run the targeted classifier tests and verify pass**

Run: `npx vitest run src/moderation/classifier.test.mjs`

Expected:
- PASS

- [ ] **Step 6: Commit the classifier change**

```bash
git add src/moderation/classifier.mjs src/moderation/classifier.test.mjs
git commit -m "fix: enforce sexual content separately from broad nudity"
```

---

## Chunk 3: Preserve Labels and End-to-End Behavior

### Task 3: Add failing vocabulary and label-mapping tests

**Files:**
- Modify: `src/moderation/vocabulary.test.mjs`
- Modify: `src/moderation/vocabulary.mjs`

- [ ] **Step 1: Write the failing vocabulary tests**

Add:

```js
expect(classifierCategoryToLabels('sexual')).toEqual(['sexual']);
expect(classifierCategoryToLabels('porn')).toEqual(['porn']);
```

- [ ] **Step 2: Run the targeted vocabulary tests and verify failure**

Run: `npx vitest run src/moderation/vocabulary.test.mjs`

Expected:
- FAIL because `classifierCategoryToLabels()` does not yet map `sexual` or `porn`

- [ ] **Step 3: Implement the minimal vocabulary change**

In `src/moderation/vocabulary.mjs`, extend the classifier-category map:

```js
sexual: ['sexual'],
porn: ['porn'],
```

- [ ] **Step 4: Run the targeted vocabulary tests and verify pass**

Run: `npx vitest run src/moderation/vocabulary.test.mjs`

Expected:
- PASS

- [ ] **Step 5: Commit the vocabulary change**

```bash
git add src/moderation/vocabulary.mjs src/moderation/vocabulary.test.mjs
git commit -m "fix: preserve sexual content labels in moderation output"
```

### Task 4: Add pipeline regression tests and make the full path pass

**Files:**
- Modify: `src/moderation/pipeline.test.mjs`
- Modify: `src/moderation/pipeline.mjs` (only if the tests expose additional glue changes)
- Optionally modify: `src/moderation/downstream-publishing.test.mjs`

- [ ] **Step 1: Write the failing benign-content pipeline regression**

Add a Hive-backed moderation pipeline test where benign male-coded classes are high but explicit sexual classes are absent:

```js
expect(result.action).toBe('SAFE');
expect(result.downstreamSignals?.hasSignals).toBe(true);
expect(result.downstreamSignals?.scores?.nudity).toBeGreaterThan(0.8);
expect(result.downstreamSignals?.scores?.sexual ?? 0).toBe(0);
expect(result.downstreamSignals?.scores?.porn ?? 0).toBe(0);
```

- [ ] **Step 2: Write the failing warning regression**

Add a Hive-backed pipeline test where `yes_sexual_display` or `yes_sex_toy` is high:

```js
expect(result.action).toBe('AGE_RESTRICTED');
expect(result.primaryConcern).toBe('sexual');
```

- [ ] **Step 3: Write the failing explicit-ban regression**

Add a Hive-backed pipeline test where `yes_sexual_activity` or `animated_explicit_sexual_content` is high:

```js
expect(result.action).toBe('PERMANENT_BAN');
expect(result.primaryConcern).toBe('porn');
```

- [ ] **Step 4: Run the targeted pipeline tests and verify failure**

Run: `npx vitest run src/moderation/pipeline.test.mjs`

Expected:
- FAIL until the new score categories are flowing cleanly end to end

- [ ] **Step 5: Make the smallest pipeline-level adjustment needed**

Expected minimal or no code changes outside the already-modified files. Only touch `src/moderation/pipeline.mjs` or `src/moderation/downstream-publishing.test.mjs` if:

- score defaults are missing from end-to-end output
- downstream signal assertions need an explicit regression harness

Do **not** change Blossom mapping or unrelated moderation rules.

- [ ] **Step 6: Run the targeted pipeline tests and verify pass**

Run: `npx vitest run src/moderation/pipeline.test.mjs`

Expected:
- PASS

- [ ] **Step 7: Run the relevant focused suite**

Run:

```bash
npx vitest run src/moderation/providers/hiveai/normalizer.test.mjs src/moderation/classifier.test.mjs src/moderation/vocabulary.test.mjs src/moderation/pipeline.test.mjs
```

Expected:
- PASS

- [ ] **Step 8: Run the repo verification commands**

Run:

```bash
npm run lint
npm test
```

Expected:
- PASS

- [ ] **Step 9: Commit the regression coverage and any remaining glue**

```bash
git add src/moderation/pipeline.test.mjs src/moderation/pipeline.mjs src/moderation/downstream-publishing.test.mjs
git commit -m "test: cover benign nudity and explicit sexual enforcement"
```

---

## Notes For Implementers

- Do not touch `notifyBlossom()` mapping in `src/index.mjs`. The serving bug is caused by upstream action selection, not Blossom transport.
- Do not reintroduce broad `nudity` into automatic enforcement.
- Do not broaden `porn` to include generic topless / swimwear classes. If the provider does not explicitly distinguish pornographic context, bias toward non-enforcement.
- Preserve `downstreamSignals` for benign nudity so trust-and-safety labels still flow.
- Keep AI/deepfake, self-harm, hate, gore, weapon, and drug logic unchanged unless a test proves collateral regression.
