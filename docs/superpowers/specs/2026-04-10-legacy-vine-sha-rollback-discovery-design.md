# Legacy Vine SHA Rollback Discovery Design

## Summary

Legacy Vine imports intentionally use the Nostr `d` tag for the Vine ID, not the media SHA-256. The classic Vine rollback path currently tries to resolve archive events by querying `#d = sha256`, which misses those events and leaves stale moderation enforcement in place.

## Goal

Allow the classic Vine rollback flow to resolve legacy Vine archive events by media SHA-256 using the event's `x` tag or `imeta x` value, without changing the event format or legacy Vine policy.

## Approach

Add a relay lookup helper that finds kind `34235`/`34236` events by scanning returned events for a matching blob hash in:

- top-level `x` tags
- `imeta` parameters with `x <sha256>`

Then update the classic Vine rollback helper to use that SHA-aware lookup instead of assuming `d = sha256`.

## Constraints

- Keep legacy Vine event shape unchanged: `d = vine_id` remains intentional.
- Do not broaden moderation policy in this patch.
- Do not re-run paid moderation providers.
- Keep the fix scoped to relay lookup and rollback discovery.

## Verification

- A failing test proves a legacy Vine event with `d = vine_id` and `x = sha256` is discoverable by SHA.
- A failing test proves rollback candidate resolution accepts that event as a classic Vine.
- Existing rollback tests remain green.
