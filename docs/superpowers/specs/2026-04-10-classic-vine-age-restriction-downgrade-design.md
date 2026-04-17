# Classic Vine Age Restriction Downgrade Design

## Summary

Legacy Vine imports are still carrying stale machine-applied moderation outcomes that are too restrictive. The new operational policy is to downgrade eligible machine-applied non-`SAFE` legacy Vine rows to `AGE_RESTRICTED`, while skipping anything with evidence of human or trust-and-safety review.

## Goal

Add an operational script that:

- discovers legacy Vine imports from live relay data
- resolves their blob SHA-256 from `x` / `imeta x`
- checks current moderation state
- skips anything with human-review signals
- downgrades remaining machine-applied non-`SAFE` rows to `AGE_RESTRICTED`

## Approach

Use a new script in `scripts/` with preview and execute modes.

Discovery:
- query kind `34236` events from the relay
- confirm classic Vine via `platform=vine`, archive client markers, `vine.co` source URL, or pre-2018 archive metadata
- extract media SHA from `imeta x` or `x`

Eligibility:
- current moderation decision exists
- current action is not `SAFE`
- skip if `reviewed_by` is set
- skip if `review_notes` is set
- skip if no moderation row exists

Execution:
- call existing authenticated `/api/v1/moderate` with `action = AGE_RESTRICTED`
- store checkpoints and a JSON report for resumable runs

## Constraints

- Do not change legacy Vine event format.
- Do not override rows with human/T&S review evidence.
- Do not add a new bulk endpoint in this patch unless forced by missing API surface.
- Keep the default mode as preview.

## Verification

- Unit tests cover classic-Vine discovery and eligibility filtering.
- Unit tests prove rows with `reviewed_by` or `review_notes` are skipped.
- Unit tests prove eligible rows generate `AGE_RESTRICTED` updates.
