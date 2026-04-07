# Nudity Enforcement Policy Design

## Goal

Stop auto-restricting or auto-removing benign nudity such as shirtless men, swimwear, beachwear, and non-sexual topless content, while still:

- preserving moderation labels and downstream trust-and-safety signals
- auto-warning sexually explicit content
- continuing to auto-ban porn, full-frontal nudity, simulated sex, CSAM, and other already-banworthy categories

## Problem

The current pipeline collapses broad Hive.AI classes into the enforcement category `nudity`, then treats `nudity` as a direct moderation action category.

That means benign classes such as:

- `yes_male_nudity`
- `yes_male_underwear`
- `yes_male_swimwear`
- generic suggestive / NSFW classes

can currently become:

- `REVIEW`
- `QUARANTINE`
- `AGE_RESTRICTED`

Those actions are then forwarded to Blossom, where `QUARANTINE` maps to `RESTRICT` and `AGE_RESTRICTED` maps to restricted serving. The result is that content that should only be labeled can be hidden or restricted automatically.

## Approved Policy

### Benign nudity

The following should remain serveable by default and should not auto-enforce:

- nipples simply existing, regardless of gender, when the chest is not the focus
- shirtless / topless but non-sexual content
- swimwear
- beach activities
- breastfeeding

This content may still emit moderation labels and downstream signals.

### Sexual content

Sexual content should receive warnings, meaning it should auto-map to `AGE_RESTRICTED`.

Examples:

- sexually suggestive behavior
- tiny underwear presented sexually
- twerking in a sexual context
- grabbing breasts
- setups for porn shoots
- displays or setups of sex toys

### Ban-grade explicit content

The following should remain auto-ban eligible:

- porn
- full frontal nudity
- simulated sex
- naked flash mobs
- anything sexual involving minors or people who appear underage

## Design

### 1. Separate label signals from enforcement signals

The moderation pipeline currently uses one score bucket for both:

- public / downstream labels
- enforcement decisions

That coupling is the root cause of the false positives.

The fix is to preserve two conceptual layers:

- broad label signals
- narrower enforcement signals

Broad label signals may include benign nudity classes. Enforcement signals must be limited to categories that actually justify automatic serving changes.

### 2. Narrow Hive nudity normalization

Hive moderation classes should no longer all collapse into enforcement-grade `nudity`.

Instead:

- benign male-coded classes like `yes_male_nudity`, `yes_male_underwear`, and `yes_male_swimwear` should contribute to label-only nudity context
- generic classes like `general_suggestive` should not auto-enforce on their own
- sexually explicit classes such as `yes_sexual_activity`, `yes_sexual_display`, and sex-toy related classes should map into an enforcement-grade `sexual` bucket
- the strongest explicit / pornographic classes should map into an enforcement-grade `porn` bucket

This keeps broad awareness while preventing benign content from being fed into the enforcement path.

### 3. Remove broad `nudity` from automatic enforcement

The classifier should stop treating broad `nudity` as a direct enforcement category.

Instead:

- `nudity` remains a label / downstream context category
- `sexual` becomes `AGE_RESTRICTED`
- `porn` becomes `PERMANENT_BAN`

Existing non-nudity policy remains unchanged:

- AI-generated: unchanged
- deepfake: unchanged
- self-harm: unchanged
- hate / offensive: unchanged
- gore: unchanged
- violence, drugs, weapons, etc.: unchanged

### 4. Preserve downstream moderation context

Benign nudity should still be available for:

- moderation labels
- ClickHouse moderation label writes
- downstream trust-and-safety context
- audits and analytics

This means a `SAFE` serving action can still carry meaningful moderation metadata.

### 5. Do not change Blossom action mapping

The issue is upstream policy classification, not Blossom transport.

No Blossom changes are required. Once the classifier stops emitting enforcement actions for benign nudity, Blossom will stop restricting that content automatically.

## Files Expected To Change

### Core policy and provider mapping

- `src/moderation/providers/hiveai/normalizer.mjs`
- `src/moderation/classifier.mjs`
- `src/moderation/pipeline.mjs`

### Tests

- `src/moderation/providers/hiveai/normalizer.test.mjs`
- `src/moderation/classifier.test.mjs`
- `src/moderation/pipeline.test.mjs`
- optionally `src/moderation/downstream-publishing.test.mjs` if downstream semantics need stronger regression coverage

## Testing Strategy

Tests should prove all of the following:

1. Benign male-coded nudity classes do not produce enforcement-grade actions.
2. Benign topless / swimwear content stays `SAFE`.
3. Benign topless / swimwear content still emits label/downstream moderation context.
4. Sexual content auto-maps to `AGE_RESTRICTED`.
5. Porn / simulated sex / strongest explicit content still auto-map to `PERMANENT_BAN`.
6. Existing AI, self-harm, hate, gore, and unrelated moderation rules are not regressed.

## Non-Goals

- no Blossom webhook contract changes
- no backfill / automatic undo of already-restricted historical items
- no changes to human moderator override actions
- no redesign of unrelated moderation categories

## Risks

### Under-enforcement risk

If the benign-vs-sexual split is too permissive, explicit sexual content may stop warning correctly.

Mitigation:

- write explicit fixture tests for sexual activity, sexual display, and pornographic classes
- keep explicit-content mappings narrow and test-driven

### Label regression risk

If benign nudity is removed entirely instead of separated, we lose useful trust-and-safety context.

Mitigation:

- preserve broad nudity in downstream / label paths
- test for `SAFE` plus retained labels

### Historical content risk

Previously restricted items will remain restricted until separately reviewed or backfilled.

Mitigation:

- handle new policy first
- treat historical cleanup as a separate follow-up project

## Recommended Implementation Order

1. Add failing tests for benign male-coded nudity staying serveable.
2. Add failing tests for sexual content warning behavior.
3. Add failing tests for porn / explicit content ban behavior.
4. Narrow Hive class normalization to distinguish benign nudity from sexual / pornographic content.
5. Update classifier enforcement rules to use `sexual` and `porn`, not broad `nudity`.
6. Verify downstream label behavior still includes benign nudity signals.
7. Run targeted and full moderation test suites.
