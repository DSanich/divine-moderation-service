# Classic Vine Enforcement Rollback Design

## Summary

Divine is currently hiding confirmed classic/original Vine archive videos behind stale moderation enforcement. The immediate symptom is `404` media responses for videos that should be publicly served, including creator-owned archive content that predates Divine by years.

This is not a classifier-quality problem first. It is an enforcement-state problem:

1. Existing moderation decisions were written to `moderation_results`.
2. Those decisions were mirrored to Blossom via `notifyBlossom()`.
3. Legacy scan and queue paths skip hashes that already exist in `moderation_results`.
4. As a result, tens of thousands of already-blocked archive Vines stay blocked even after the forward moderation fix exists.

The incident response must restore serving first. It must not re-run paid moderation providers.

## Policy

If a video is a confirmed classic/original Vine, it must be served.

For the rollback path:

- No AI/deepfake signal may keep a classic Vine hidden.
- No nudity/violence/gore signal may keep a classic Vine hidden.
- Existing scores and categories may remain stored as historical metadata.
- The rollback job itself must not publish new moderation reports.
- The rollback job itself must not call Hive, Sightengine, or any other paid moderation provider.

## Goals

- Restore public serving for all confirmed classic/original Vine videos currently returning `404` because of stale moderation enforcement.
- Make the rollback idempotent so it can be resumed safely.
- Keep historical moderation data intact while removing the serving restriction.
- Reuse existing Blossom enforcement plumbing so the restore path matches production serving behavior.

## Non-Goals

- Re-moderating archive Vine videos.
- Recomputing moderation scores or categories.
- Publishing fresh trust-and-safety reports during the incident rollback.
- Refactoring the broader moderation pipeline beyond what is needed to stop future regressions.

## Existing Constraints

### Current Skip Logic

The current queue worker in [`src/index.mjs`](../../../src/index.mjs) skips any SHA that already exists in `moderation_results`. The legacy `/api/v1/scan` and `/api/v1/batch-scan` endpoints do the same. That means the backlog cannot be repaired by re-queueing existing videos through the normal path.

### Existing Storage Shape

`moderation_results` stores action, scores, categories, and audit fields, but it does not store enough archive/Vine metadata to identify the full classic-Vine backlog by SQL alone.

### Existing Enforcement Path

`notifyBlossom()` already knows how to restore serving when it receives `SAFE`. We should use that path instead of inventing a second blob-state API.

## Proposed Design

### 1. Separate the forward fix from the incident rollback

Two changes are required:

- The forward moderation fix for new and newly-processed imports so future classic Vines do not get blocked.
- A dedicated incident rollback job for already-blocked hashes so historical `404`s are actively undone.

These are related but distinct. The rollback design here focuses on the historical backlog.

### 2. Add a dedicated admin rollback endpoint

Add an authenticated admin endpoint that performs classic-Vine enforcement rollback directly against existing moderation state.

Suggested shape:

- `POST /admin/api/classic-vines/rollback`

Suggested request body:

```json
{
  "mode": "preview",
  "source": "sha-list",
  "sha256s": ["..."],
  "cursor": null,
  "limit": 500
}
```

Supported modes:

- `preview`: resolve candidates and report how many would be restored without changing state
- `execute`: rewrite enforcement and notify Blossom
- `resume`: continue an interrupted job using a cursor or offset

### 3. Accept explicit SHA lists first, with relay-verified fallback discovery

Preferred source of truth:

- archive/import pipeline export of affected SHAs

Fallback source:

- enumerate candidate SHAs from existing moderation rows, then resolve relay metadata per SHA before acting

The endpoint should accept both, because waiting on a separate export blocks incident response.

### 4. Use permissive classic-Vine confirmation for the emergency pass

The rollback path should confirm classic/original Vine status from existing metadata, not from paid moderation.

Accepted signals:

- `platform=vine`
- source URL or `r` tag contains `vine.co`
- `vine_id` or `vineHashId` exists
- archive client markers such as `vine-archive-importer` or `vine-archaeologist`
- `published_at < 2018-01-01` as a fallback only when the SHA already came from an archive-oriented candidate source

This emergency matcher is intentionally broader than normal moderation enforcement. The outage cost of leaving classic Vines hidden is higher than the risk of restoring an archive candidate that was already imported as Vine content.

### 5. Rewrite enforcement only

For each confirmed classic Vine:

1. Read the current D1 row from `moderation_results`.
2. Preserve existing `scores`, `categories`, `provider`, and existing timestamps.
3. Upsert the row with:
   - `action = 'SAFE'`
   - `review_notes = 'incident rollback: classic vine restore'`
   - `reviewed_by = 'classic-vine-rollback'`
   - `reviewed_at = <now>`
4. Delete all stale enforcement KV keys:
   - `review:${sha256}`
   - `quarantine:${sha256}`
   - `age-restricted:${sha256}`
   - `permanent-ban:${sha256}`
5. Call `notifyBlossom(sha256, 'SAFE', env)`.

The rollback job must not:

- call `moderateVideo()`
- call Hive or Sightengine
- overwrite stored scores/categories
- publish new kind `1984` reports
- publish new ATProto moderation payloads

### 6. Make the job chunked and idempotent

The backlog is large enough that the endpoint must support chunked execution.

Requirements:

- bounded `limit` per request
- per-SHA success/failure recording
- resumable cursor or offset
- safe to rerun without damaging already-restored items

If a SHA is already `SAFE`, the job should treat it as a no-op success after clearing any stale enforcement keys and ensuring Blossom is told `SAFE`.

### 7. Record an operational rollback report

Each run should return and log:

- mode
- source
- total candidates processed
- restored count
- skipped count
- failed count
- cursor for next page
- a small sample of failures with error messages
- started and finished timestamps

This is needed for incident tracking and reruns.

## Verification

Verification for the rollback is operational, not model-based:

1. `preview` reports the expected candidate counts before execution.
2. `execute` reports restored hashes and low failure counts.
3. Sample known-bad hashes, especially Jack and Jack Vine hashes, and confirm the media URLs no longer return `404`.
4. Confirm no paid moderation provider traffic was triggered by the rollback path.
5. Confirm rerunning the same chunk does not reintroduce blocking state.

## Operator Guidance for Large Batches

The rollback endpoint supports both explicit `videos[]` payloads (with pre-resolved `nostrContext`) and raw `sha256s[]` payloads.

- Prefer `videos[]` for large incident runs whenever possible. This avoids relay metadata lookups entirely and is the fastest path.
- `sha256s[]` is still supported for emergency runs, but it now uses batched relay lookup with bounded concurrency.
- Default lookup tuning:
  - `lookup_chunk_size = 25`
  - `lookup_concurrency = 3`
- Safe starting points:
  - pre-resolved `videos[]`: request `limit` up to `500`
  - raw `sha256s[]`: request `limit` of `100-250` first, then increase after observing relay stability
- If relay errors or timeouts appear, reduce `lookup_chunk_size` and/or `lookup_concurrency` before retrying.

## File-Level Design

- [`src/index.mjs`](../../../src/index.mjs)
  - add the authenticated admin rollback endpoint
  - reuse existing D1/KV/Blossom helpers
- `src/moderation/classic-vine-rollback.mjs`
  - candidate confirmation
  - D1/KV enforcement rewrite helpers
  - chunk/result formatting
- `src/moderation/classic-vine-rollback.test.mjs`
  - unit coverage for candidate confirmation and rewrite semantics
- [`src/index.test.mjs`](../../../src/index.test.mjs)
  - end-to-end coverage for preview/execute behavior and Blossom notification

## Rollout

1. Merge and deploy the forward classic-Vine serveability fix.
2. Deploy the admin rollback endpoint.
3. Run `preview` on the known backlog source.
4. Run `execute` in chunks until the backlog is restored.
5. Spot-check previously broken public URLs.

## Open Questions

None blocking for implementation. The endpoint should support both explicit SHA lists and relay-verified fallback discovery so incident response can begin immediately.
