# Original Vine Serveable Override Design

## Summary

Imported original/classic Vine videos are currently vulnerable to false-positive AI-generated moderation results. When that happens, the service can quarantine or block archive content that should remain visible to users. The required policy is:

- Original Vines must remain serveable to users.
- AI-generated and deepfake scores for original Vines must still be retained for training/debugging.
- Non-AI moderation signals for original Vines, such as nudity, gore, violence, and other safety labels, must still flow to downstream moderation systems for sorting and trust-and-safety context.

## Current Problem

Two issues combine to produce the bad behavior:

1. `moderateVideo()` only fetches Nostr event context when `metadata.videoUrl` is absent. Imported videos often arrive with `metadata.videoUrl`, which means Vine-specific metadata is skipped and `isOriginalVine()` never runs on the full context.
2. Downstream publishing is tied directly to `action !== 'SAFE'`. If an original Vine is forced to `SAFE`, existing label/report flows disappear even when the content has legitimate moderation signals such as nudity or gore.

## Goals

- Keep original Vines publicly accessible.
- Stop AI/deepfake false positives from blocking archive Vine content.
- Preserve raw model scores for training and auditability.
- Preserve non-AI moderation signals for downstream labeling, reporting, and sorting.
- Avoid schema migrations and keep current stored moderation rows compatible.

## Non-Goals

- Changing the meaning of human-verified NIP-32 kind `1985` label events.
- Reworking the entire moderation vocabulary or Blossom enforcement model.
- Reclassifying all pre-2018 content as Vine content without stronger indicators.

## Design

### 1. Resolve Vine Context Even When `videoUrl` Is Present

`moderateVideo()` will continue to prefer `metadata.videoUrl` as the URL sent to providers, but it will still attempt to fetch the Nostr event for the SHA so the service can derive archive/Vine policy context even for imported videos.

This decouples URL resolution from policy detection.

### 2. Separate Moderation Signals From Enforcement

The moderation pipeline will keep raw classification results intact, then derive a second, downstream-safe signal payload.

- `action` remains the enforcement outcome used by Blossom/public serving.
- `scores` remain the raw moderation outputs stored for training/debugging.
- A new derived signal object captures what should still be published as moderation context even when enforcement is overridden to `SAFE`.

For original Vines:

- `action` is forced to `SAFE`.
- `ai_generated` and `deepfake` scores remain in `scores`.
- `ai_generated` and `deepfake` are excluded from derived downstream signals.
- Non-AI signals such as nudity, violence, gore, weapons, self-harm, and text-based signals remain eligible for downstream publishing.

### 3. Add Explicit Policy Metadata To Results

The moderation result will carry explicit policy metadata so downstream code does not need to reverse-engineer why a result is `SAFE`.

Expected fields:

- `policyContext.originalVine`
- `policyContext.enforcementOverridden`
- `policyContext.overrideReason`
- `downstreamSignals` containing the filtered scores/categories that should still publish

This makes the split between serving policy and moderation context visible in storage, logs, tests, and debugging output.

### 4. Tighten Original Vine Detection Priority

Original Vine detection will prefer hard evidence:

- `platform=vine`
- `client=vine-archaeologist`
- `vine_hash_id`
- `vine.co` source URL

The existing pre-2018 timestamp check remains available as a weak fallback, but it should not be treated as equivalent to the explicit Vine markers when deciding whether to apply the serveable override.

## Data Flow

1. Resolve Nostr metadata for the SHA even if `metadata.videoUrl` already exists.
2. Run moderation providers as before, including skip-AI behavior for original Vines where supported.
3. Classify the raw moderation result.
4. Apply original-Vine policy override:
   - keep raw scores
   - force enforcement `action` to `SAFE`
   - derive publishable downstream signals with AI/deepfake removed
5. Store the result in D1/KV as before, with added policy metadata.
6. Notify Blossom using only enforcement `action`.
7. Publish labels/reports/ATProto payloads using `downstreamSignals`, not just `action`.

## Downstream Behavior

### Blossom / Public Serving

Uses `action` only. Original Vines remain accessible.

### ClickHouse Labels

Use `downstreamSignals.scores` so original Vines can still receive labels for nudity/gore/violence and other non-AI safety signals.

### Nostr Reports

Use derived downstream signals to publish moderation context for original Vines when there are meaningful non-AI concerns, even though enforcement remains `SAFE`.

### ATProto Webhook

Build payloads from derived downstream signals instead of treating `SAFE` as an unconditional “publish nothing” result.

## Testing Strategy

- Regression test: imported original Vine with `metadata.videoUrl` still resolves Vine context.
- Regression test: original Vine with strong AI-only score remains `SAFE`, retains AI score, and suppresses AI downstream signals.
- Regression test: original Vine with nudity/gore/violence remains `SAFE` but still emits downstream moderation signals.
- Unit test: ATProto webhook builder accepts explicit downstream signals even when `action === 'SAFE'`.
- Unit test: original-Vine detection prioritizes hard Vine evidence and preserves the weaker timestamp fallback behavior.

## Risks

- If the override trigger is too broad, non-Vine archival media could remain serveable when it should not.
- If downstream publishing is not clearly separated from enforcement, future code paths may accidentally reintroduce the coupling.
- Existing admin tooling may need to learn to display both enforcement state and downstream moderation context distinctly.

## Mitigations

- Prefer explicit Vine indicators before timestamp fallback.
- Add explicit policy metadata to moderation results.
- Cover the serveable override with regression tests in pipeline and webhook layers.
