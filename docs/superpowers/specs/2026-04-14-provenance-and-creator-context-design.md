# Provenance And Creator Context Design

## Summary

Moderators need a reliable way to tell whether a video is likely original legacy content, especially original Vine-era media, before interpreting AI-generated scores. Today the moderation UI mostly shows ingestion or moderation timestamps, while older source dates are inconsistently preserved through the backend. This design adds a normalized provenance model and a richer creator context panel so moderators can quickly answer two questions:

1. Is this likely an original Vine or other pre-2022 legacy upload?
2. Who posted it, and what is their moderation and platform history?

This design was originally guidance-only. As of 2026-04-17 it also covers a single targeted enforcement change for C2PA ProofMode: a cryptographically-valid ProofMode capture attestation downgrades a Hive/RD AI-driven QUARANTINE to REVIEW so a human decides. All other provenance surfaces remain guidance-only. See the "ProofMode Enforcement" section below.

## Goals

- Compute a first-class provenance summary for every admin video payload.
- Preserve and rank trustworthy age signals, including Vine-specific evidence.
- Surface provenance prominently in dashboard and swipe review.
- Add a `Creator Info` affordance with moderation-local stats plus public creator metadata from `api.divine.video`.
- Keep enforcement logic unchanged in this iteration.

## Non-Goals

- Automatically changing moderation actions based on provenance, **except** the one targeted rule in "ProofMode Enforcement" below.
- Using generic C2PA validity (non-ProofMode, non-capture-authenticated) to rebut AI detectors — C2PA happily signs AI-generated manifests.
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

### ProofMode / C2PA Verification

Verification is performed by `divine-inquisitor` (Rust microservice at `github.com/divinevideo/divine-inquisitor`), **not** by `proofsign.divine.video` (which is the signing side only, no verify endpoint). Divine-moderation-service calls inquisitor with the media URL and normalizes the response into `video.c2pa` on every admin payload.

Naming note: the C2PA verification result is exposed as a top-level `video.c2pa` field, NOT as `video.provenance.proofmode`. The name `provenance.proofmode` is already taken by Nostr-tag ProofMode data (a different, pre-existing evidence channel from the Nostr event's `["proofmode", ...]` tag). The two can coexist and reinforce each other — `video.provenance.proofmode` for the self-reported Nostr tag, `video.c2pa` for the cryptographically verified manifest inside the media bytes.

`video.c2pa` shape:

```json
{
  "state": "valid_proofmode | valid_c2pa | valid_ai_signed | invalid | absent | unchecked",
  "hasC2pa": true,
  "valid": true,
  "isProofmode": true,
  "validationState": "valid",
  "claimGenerator": "ProofMode/1.1.9 Android/14",
  "captureDevice": "Google Pixel 8 Pro",
  "captureTime": "2024:07:22 14:33:51",
  "signer": "...Issuer DN... (moderator-only)",
  "assertions": ["stds.exif", "org.proofmode.location", "c2pa.hash.data"],
  "verifiedAt": "2026-04-17T10:00:00.000Z",
  "checkedAt": "2026-04-17T10:00:00.000Z"
}
```

Normalization of `state` (derived from inquisitor response):

- `valid_proofmode` — `has_c2pa=true && valid=true && is_proofmode=true`. The strong capture-authenticity signal.
- `valid_c2pa` — `has_c2pa=true && valid=true && !is_proofmode` and `claim_generator` does not match a known AI tool. Generic authenticated provenance.
- `valid_ai_signed` — `has_c2pa=true && valid=true` and `claim_generator` matches a known AI-generation tool (Adobe Firefly, DALL·E, etc.). Valid signature, but the signature itself asserts AI origin.
- `invalid` — `has_c2pa=true && valid=false`. Manifest present but signature check failed. Often innocent (transcoding, clock skew, buggy app) — treat as neutral.
- `absent` — `has_c2pa=false`. No manifest. The default for most content.
- `unchecked` — verification failed (inquisitor timeout/error) or not yet run.

### Inquisitor API Contract (summary)

`POST /verify` on divine-inquisitor accepts:

- JSON mode: `Content-Type: application/json`, body `{url, mime_type}`. Inquisitor range-fetches up to `RANGE_FETCH_BYTES` (default 2 MB) from the URL. Typical 100-500 ms.
- Bytes mode: raw body, `x-mime-type` header, optional `x-content-hash`. Typical <50 ms.

Response fields consumed: `has_c2pa`, `valid`, `validation_state`, `is_proofmode`, `claim_generator`, `capture_device`, `capture_time`, `signer`, `signature_info`, `assertions`, `actions`, `ingredients`, `verified_at`, `content_hash`, `error`. Full schema in `reference_divine_inquisitor.md` (project memory).

### ProofMode / C2PA Enforcement

Two targeted, automatic moderation-action rules are driven by provenance. Both are independent of each other and of Hive/RD.

**Rule 1 — ProofMode downgrade:**
If Hive AI or Reality Defender flag a video as AI-generated AND `video.c2pa.state === "valid_proofmode"`, the moderation action downgrades from QUARANTINE to REVIEW. The video stays visible to users while it sits in the moderator review queue.

**Rule 2 — Signed-AI short-circuit:**
If `video.c2pa.state === "valid_ai_signed"` (valid C2PA signature whose `claim_generator` is a known AI-generation tool — Adobe Firefly, DALL·E, Midjourney, Stable Diffusion, Sora, Runway, Ideogram, etc.), the moderation action is forced to QUARANTINE and **Hive is not called at all**. Reality Defender is also skipped. The tool's own cryptographic declaration is authoritative AI evidence, so paying for Hive or polling RD adds cost and latency with no new information. The pipeline call order is therefore: inquisitor first, then short-circuit to QUARANTINE on `valid_ai_signed`, otherwise continue into the existing Hive/RD flow. Humans review every signed-AI QUARANTINE for labeling or approval.

This loses Hive's non-AI category scores (nudity, violence, self-harm) on signed-AI content. That's an acceptable trade because moderators review every QUARANTINE manually, the volume of signed-AI content should be small, and an opt-in Hive call can be added at review time if a moderator wants those scores.

All other states (`valid_c2pa`, `invalid`, `absent`, `unchecked`) fall through to the existing Hive/RD routing — no auto-downgrade, no auto-escalate.

Rationale:
- `valid_c2pa` without ProofMode does not rebut AI detection (generic C2PA can sign AI manifests), but it also doesn't imply AI — it's a neutral "authenticated provenance" signal.
- `invalid` is dominated by non-malicious causes (transcoding strips signatures, buggy capture apps, clock skew, re-encoding pipeline) — escalating on invalid would punish the wrong users, including penalizing our own pipeline for stripping signatures.
- `unchecked` means inquisitor timed out or errored — we treat it as absent and never block moderation on verification latency.

The dashboard surfaces every state as a distinct badge so moderators can spot patterns (e.g. a user consistently producing invalid proofs) even though the system doesn't auto-act on every state.

### Caching and Triggering

- Verification runs in the moderation pipeline on ingest, alongside the Hive submission, with the result persisted to the moderation record and cached in KV under `c2pa:{sha256}` for 30 days. Do not re-verify on every admin render.
- Re-verify on demand only when a moderator hits a dashboard control or when the cache is empty.
- On inquisitor timeout/error, record `state: "unchecked"` and fall through to default routing — never block moderation on verification latency.

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

Every moderation card in dashboard and swipe review should display two independent badges — an age/origin badge and a ProofMode badge — because they measure different things.

Age/origin badge (one of):
- `Original Vine`
- `Pre-2022 Legacy`
- `Unknown Provenance`

ProofMode / C2PA badge (one of):
- `Valid ProofMode` (green — capture-authenticated, only this state downgrades AI quarantine)
- `Valid C2PA` (blue — authenticated provenance, neutral for enforcement)
- `Valid but AI-signed` (orange — valid signature claims AI origin)
- `Invalid Proof` (gray — often transcoding or clock skew, informational only)
- no badge when `state === "absent"` (most content)

Supporting line beneath the badges:
- `Published Aug 21, 2014 via published_at`
- `ProofMode captured 2024:07:22 on Google Pixel 8 Pro`
- `Posted Nov 18, 2021 via Nostr`
- `Unknown provenance`

`Original Vine`, `Pre-2022 Legacy`, and `Valid ProofMode` should visually read as "AI unlikely" without changing scoring behavior (except the one ProofMode enforcement rule above). `Unknown Provenance`, `Valid C2PA`, and `Invalid Proof` should stay neutral.

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
- C2PA / ProofMode verification result fetched from divine-inquisitor and normalized into `video.c2pa`

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
