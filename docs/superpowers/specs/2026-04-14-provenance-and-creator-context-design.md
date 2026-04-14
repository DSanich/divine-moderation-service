# Provenance And Creator Context Design

## Summary

Moderators need a reliable way to tell whether a video is likely original legacy content, especially original Vine-era media, before interpreting AI-generated scores. Today the moderation UI mostly shows ingestion or moderation timestamps, while older source dates are inconsistently preserved through the backend. This design adds a normalized provenance model and a richer creator context panel so moderators can quickly answer two questions:

1. Is this likely an original Vine or other pre-2022 legacy upload?
2. Who posted it, and what is their moderation and platform history?

This change is guidance-only for now. It does not automatically suppress or downgrade AI-generated moderation outcomes.

## Goals

- Compute a first-class provenance summary for every admin video payload.
- Preserve and rank trustworthy age signals, including Vine-specific evidence.
- Surface provenance prominently in dashboard and swipe review.
- Add a `Creator Info` affordance with moderation-local stats plus public creator metadata from `api.divine.video`.
- Keep enforcement logic unchanged in this iteration.

## Non-Goals

- Automatically changing moderation actions based on provenance.
- Inventing creator metrics we cannot source authoritatively.
- Using creator-only analytics endpoints that require the creator's own NIP-98 auth.

## Current Problems

- Admin cards mostly render `receivedAt` or `moderated_at`, not original publication dates.
- `published_at` is parsed from Nostr/import metadata but dropped in several admin API response builders.
- `event.created_at` is also inconsistently preserved for admin views.
- Provenance evidence is spread across raw tags, D1 columns, and ad hoc Vine heuristics.
- Creator context is limited to local moderation counters and enforcement badges; it does not use the richer public Funnelcake profile and social APIs.

## Proposed Design

### Provenance Model

Each admin video response should expose a normalized `provenance` object:

```json
{
  "status": "original_vine | pre_2022_legacy | unknown_or_modern",
  "label": "Original Vine",
  "date": "2014-08-21T00:00:00.000Z",
  "dateSource": "published_at | proofmode | nostr_created_at | received_at | none",
  "reasons": [
    "platform:vine",
    "source_url:vine.co",
    "published_at:2014-08-21"
  ],
  "isPre2022": true,
  "isOriginalVine": true,
  "proofmode": null
}
```

### Evidence Sources And Ranking

Use the strongest available evidence in this order:

1. `vine_signals`
   Existing Vine evidence from parsed metadata or current heuristics:
   - `platform === 'vine'`
   - Vine source URL
   - Vine importer client
   - `vine_hash_id`
   - `vine_user_id`
   - current original-Vine helper logic already used by moderation
2. `published_at`
   Original publication timestamp from Nostr/import metadata.
3. `proofmode`
   Optional imported proof/attestation timestamp and related evidence, if present in future metadata or tags.
4. `nostr_created_at`
   Nostr event `created_at`. Useful, but weaker than `published_at` because reposts/imports can be newer than the original media.
5. `received_at`
   Divine ingest timestamp. Operationally useful but weak provenance evidence.

### Classification Rules

- `original_vine`
  Strong Vine evidence exists, or a trusted publish date is in the 2013-2017 Vine era and aligns with Vine-specific metadata.
- `pre_2022_legacy`
  Best trustworthy age evidence is before January 1, 2022, but strong Vine evidence is absent.
- `unknown_or_modern`
  No trustworthy pre-2022 evidence exists.

Guardrails:

- `received_at` alone must never classify content as `pre_2022_legacy`.
- `proofmode` can support `pre_2022_legacy` but does not by itself imply `original_vine`.
- UI copy must always disclose the evidence source used.

### Proofmode Support

The current service does not yet parse `proofmode`, but the provenance model should reserve space for it. When present, preserve:

- proof timestamp
- proof source/device if available
- proof or attestation reference/hash if available

This allows imported authenticity evidence to become part of provenance without redesigning the API again.

### Creator Context Model

Each admin video response should also expose a normalized `creatorContext` object:

```json
{
  "name": "Alice",
  "pubkey": "<full pubkey>",
  "profileUrl": "https://divine.video/profile/<pubkey>",
  "stats": {
    "totalScanned": 42,
    "flagged": 8,
    "restricted": 3,
    "banned": 1,
    "review": 4,
    "riskLevel": "elevated"
  },
  "social": {
    "videoCount": 120,
    "totalEvents": 480,
    "followerCount": 3200,
    "followingCount": 180,
    "firstActivity": "2019-01-01T00:00:00.000Z",
    "lastActivity": "2026-04-14T00:00:00.000Z"
  },
  "enforcement": {
    "approvalRequired": false,
    "relayBanned": false
  }
}
```

Data sources:

- local moderation service data:
  `uploader_stats`, uploader enforcement state, existing uploaded-by/pubkey linkage
- public Funnelcake endpoints on `https://api.divine.video`
  - `GET /api/users/{pubkey}`
  - `GET /api/users/{pubkey}/social`
  - optionally `GET /api/users/{pubkey}/videos?sort=published&limit=...`

Do not depend on `GET /api/users/{pubkey}/analytics`, because it requires creator-owned NIP-98 auth and is not suitable for moderator access.

## UI Design

### Card-Level Provenance

Every moderation card in dashboard and swipe review should display:

- a prominent badge:
  `Original Vine`, `Pre-2022 Legacy`, or `Unknown Provenance`
- a supporting line:
  - `Published Aug 21, 2014 via published_at`
  - `Proofmode Jun 3, 2019`
  - `Posted Nov 18, 2021 via Nostr`
  - `Unknown provenance`

`Original Vine` and `Pre-2022 Legacy` should visually read as "AI unlikely" without changing scoring behavior. `Unknown Provenance` should stay neutral.

### Creator Info Affordance

Cards remain compact. Add a `Creator Info` button that opens a popover or modal with:

- creator name, avatar if available, and full pubkey
- Divine profile link
- local moderation counters and risk level
- enforcement badges and controls already present in the dashboard
- public Funnelcake social and account statistics
- provenance evidence details and source breakdown

This modal is the right place for richer creator history without overloading the main card.

## Backend Design

### Normalize Once In The Worker

Compute provenance server-side and return the same structure for:

- dashboard list results
- dashboard focused lookup results
- swipe review payloads
- any future admin moderation surfaces

Do not let each frontend derive provenance independently.

### Data Preservation Rules

When building admin payloads, preserve:

- `publishedAt`
- `createdAt` / `event.created_at`
- Vine metadata fields
- source URL
- proofmode fields when present

Existing D1 persistence of `published_at` remains useful, but the admin response builders must stop dropping it.

### External Creator Lookups

Fetch creator context lazily when a pubkey is known. Use conservative fallback rules:

- if `api.divine.video` succeeds, include profile/social data
- if it fails, still return local moderation stats and enforcement state
- do not block moderation card rendering on external creator data

The `Creator Info` panel can load extended creator data on demand if needed to avoid slowing list views.

## Testing Strategy

Add coverage for:

- provenance classification from Vine signals
- provenance classification from `published_at`
- provenance fallback to `event.created_at`
- guardrail that `received_at` alone does not mark legacy content
- preservation of `publishedAt` and related provenance fields in admin payloads
- creator context enrichment using local uploader stats
- creator context enrichment using mocked `api.divine.video` profile/social responses
- dashboard and swipe review rendering of provenance badges and creator info affordance

## Expected Outcome

Moderators can quickly distinguish likely original Vine and other pre-2022 legacy content from modern or unknown-provenance uploads. They also get enough creator context to judge whether a flagged video fits an established legacy uploader pattern, without changing moderation enforcement automatically.
