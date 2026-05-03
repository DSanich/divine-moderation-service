# AI Detection Reporting And Audit Ledger

**Date:** 2026-05-03
**Status:** Approved
**Scope:** admin reporting for ProofMode AI-detection cost control and moderation review visibility in `divine-moderation-service`

## Problem

The service now avoids paid Hive AI detection when a video has valid ProofMode provenance, unless a user reports it as AI-generated. That change protects spend, but the moderation team cannot yet answer the obvious operational questions:

- How many paid AI checks are still running?
- How many checks did ProofMode or signed AI provenance avoid?
- How many user AI reports forced rechecks?
- Which forced rechecks need human review?
- What is the estimated spend avoided after the policy change?

The current admin dashboard has global moderation stats, but it does not expose the AI-detection policy path or record enough durable audit data to trend the new behavior.

## User Intent

Build both:

- a dedicated admin dashboard panel that shows cost and moderation operations at a glance
- a durable D1 ledger that records policy decisions and outcomes going forward

The first version should be useful quickly and not block content visibility. Valid ProofMode content that is AI-flagged after a report should remain visible and go to human `REVIEW`.

## Design

Add a small AI-detection reporting subsystem alongside the existing admin stats.

### Source Of Truth

Use D1 as the reporting source of truth for policy events recorded after this feature ships.

Existing tables stay in place:

- `moderation_results` remains the source of final moderation action and scores.
- `user_reports` remains the source of user reports and unique reporter counts.

Add one append-only ledger table:

- `ai_detection_events` records policy decisions, user-report triggers, and moderation outcomes.

The dashboard should label exact ledger metrics as "since enabled". Any derived historical number from older `moderation_results` or `user_reports` must be clearly labeled as derived, because older rows do not prove whether Hive AI detection was skipped by ProofMode at the time.

### Ledger Events

Record three event types:

- `policy_decision`: paid AI detection ran or skipped, and why.
- `user_report`: an AI/deepfake/synthetic report triggered a forced AI recheck.
- `moderation_outcome`: final moderation action, AI score, C2PA state, and whether ProofMode downgraded an AI hide decision to `REVIEW`.

Important fields:

- `sha256`
- `event_type`
- `policy_reason`
- `c2pa_state`
- `ai_detection_ran`
- `ai_detection_forced`
- `ai_score`
- `action`
- `report_type`
- `metadata_json`
- `created_at`

Do not duplicate reporter private details into the ledger. The existing `user_reports` table already stores reporter pubkeys when needed for report workflow.

### Deduplication

Queue retries can run the same unit of work more than once. Ledger writes should include an idempotency key where possible:

- report-trigger events: `report:<sha256>:<report_type>:<created_at-or-existing-report-id-if-available>`
- policy/outcome events: `moderation:<sha256>:<uploadedAt>:<forceFlag>:<event_type>`

If an exact key already exists, ignore the duplicate. Counts should use the ledger rows, not logs.

### Dashboard API

Add an admin-only endpoint:

`GET /admin/api/ai-detection/stats?window=24h`

Return:

- top-level counts: AI runs, AI skips, ProofMode skips, signed-AI skips, forced report checks, open review items
- estimated spend avoided if an estimated per-check cost is configured
- policy breakdown by reason
- review breakdown for report-forced and ProofMode-downgraded items
- recent open review rows with `sha256`, action, C2PA state, AI score, report count, and age

Window support should start simple:

- `24h`
- `7d`
- `30d`
- `all`

### Cost Estimate

The dashboard should always show raw counts. Dollar estimates should be optional and clearly marked as estimated.

Use a config value such as `HIVE_AI_DETECTION_ESTIMATED_COST_CENTS` or leave the cost field null when not configured. This avoids hard-coding vendor pricing into application behavior.

### Dashboard UI

Add a dedicated band to `src/admin/dashboard.html`, near the existing stat cards.

Cards:

- AI detection runs
- AI detection skipped
- ProofMode skips
- report-forced rechecks
- open AI review items
- estimated spend avoided

Below the cards:

- a policy breakdown table
- a review queue slice linking into existing video review actions

The panel should reuse the existing admin dashboard style and fetch data from the new endpoint. If the endpoint fails, show a small error state and leave the rest of the dashboard usable.

### Moderation Flow Writes

Write ledger events in these paths:

- `/api/v1/report`: when an AI/deepfake/synthetic report queues a forced AI recheck.
- queue consumer / `moderateVideo`: when the policy decides whether Hive AI detection should run.
- `handleModerationResult` or the queue consumer after the D1 result write: when final action and score are known.

The policy helper should expose enough information for reporting without re-deriving the reason in multiple places.

### Review Semantics

Keep the current product behavior:

- Valid ProofMode skips paid AI detection by default.
- AI reports force AI detection.
- If forced AI detection flags valid ProofMode content as AI-generated or deepfake, the action stays `REVIEW`, not hidden.
- `REVIEW` is internal and does not restrict Blossom serving.

The dashboard should make those cases visible to moderators.

## Non-Goals

- No exact backfill of skipped AI detections before the ledger exists.
- No vendor billing reconciliation in this feature.
- No new moderation action type.
- No separate standalone dashboard app.
- No exposure of reporter private details in the reporting panel.

## Testing

Add coverage for:

- initializing the `ai_detection_events` table and indexes
- inserting idempotent ledger events
- reporting AI policy counts for `24h`, `7d`, `30d`, and `all`
- `/api/v1/report` writing a user-report ledger event for AI reports
- queue/pipeline writing policy and outcome events for ProofMode skip, no-proof run, and forced report recheck
- `/admin/api/ai-detection/stats` requiring admin auth
- dashboard HTML containing the new panel hooks and using the new endpoint

## Rollout

1. Add and apply D1 migration.
2. Deploy ledger writes and dashboard endpoint.
3. Deploy dashboard UI.
4. Verify counts start populating from new queue traffic.
5. Tune the optional estimated cost config after real Hive pricing is confirmed.
