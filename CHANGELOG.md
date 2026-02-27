# Changelog

All notable changes to the Divine Moderation Service will be documented in this file.

## [Unreleased] - 2026-02-27

### Added
- **QUARANTINE action** — New moderation state between REVIEW and PERMANENT_BAN
  - Hidden from regular users, visible to authenticated moderators via admin bypass route
  - Classifier auto-quarantines content above configurable threshold but below permanent ban
  - Manual quarantine/unquarantine via `POST /api/v1/quarantine/:sha256`
- **Decisions API** for divine-relay-manager integration
  - `GET /api/v1/decisions` — Paginated list of moderation decisions (filterable by action, since timestamp)
  - `GET /api/v1/decisions/:sha256` — Single decision lookup by content hash
  - Authenticated via Zero Trust JWT
- **Content relay NIP-56 publishing** — Moderation reports now published to both Faro and content relay (`NOSTR_RELAY_URL`)
- **Relay cache invalidation** — `notifyRelay()` sends purge requests to Funnelcake admin endpoint after bans
  - Uses `RELAY_ADMIN_URL` secret with CF Access auth headers
  - Fire-and-forget pattern, parallel to existing `notifyBlossom()`

### Removed
- **BunnyCDN moderation provider** — Removed entirely (HiveAI is now sole primary provider with Sightengine fallback)
  - Deleted `src/moderation/providers/bunnycdn/` (adapter, client, normalizer)
  - Removed parallel BunnyCDN+HiveAI pipeline path
  - Removed `BUNNY_STREAM_API_KEY` secret
  - Removed BunnyCDN provider badge from admin dashboard

### Changed
- Moderation pipeline simplified to always use fallback chain (HiveAI primary, Sightengine fallback)
- Backfill script cost estimates updated for HiveAI pricing
- Valid moderation actions now include QUARANTINE alongside SAFE, REVIEW, AGE_RESTRICTED, PERMANENT_BAN

### Configuration
- `RELAY_ADMIN_URL` — Funnelcake admin API endpoint for cache purge / event deletion (new secret)
- `QUARANTINE_THRESHOLD` — Optional threshold for auto-quarantine (defaults to medium threshold)

---

## [Unreleased] - 2025-01-25

### Added
- **Per-category human verification** - Moderators can confirm or reject individual AI detections
  - ✓ button confirms "Yes, this IS [category]"
  - ✗ button rejects "No, this is NOT [category]"
  - Verification status persisted in KV storage
  - Visual badges show verification state (green confirmed, red rejected)

- **NIP-32 label event publishing** (kind 1985) - Human-verified labels published to Nostr
  - Confirmed categories: `["l", "ai-generated", "content-warning", {metadata}]`
  - Rejected categories: `["l", "not-ai-generated", "content-warning", {metadata}]`
  - Metadata includes confidence score, verification source, sha256
  - Requires `MODERATOR_NSEC` and `NOSTR_RELAY_URL` secrets

- **Auto-approve on rejection** - Videos auto-approved when all major flags rejected
  - Major flags: nudity, violence, gore, ai_generated, deepfake, self_harm
  - If moderator rejects all detected major flags → video becomes SAFE
  - Shows "🎉 Auto-approved!" toast notification

- **Provider badges** - Dashboard shows which AI analyzed each video
  - HiveAI 🐝, SightEngine 👁️, or combined 🔗
  - "📦 Legacy" badge for older videos without provider info

- **Moderation history timeline** - Shows AI vs human decision history
  - AI classification with timestamp and provider
  - Human override with action change visualization (REVIEW → SAFE)

- **AI detection alerts** - Prominent warnings for AI-generated/deepfake content
  - Shows detected source (e.g., "Midjourney", "DALL-E")
  - Frame analysis count and confidence level
  - Yellow border for medium confidence, red for high

- **NIP-85 tags preview** - Shows what Nostr labels will be generated
  - Live preview of `["l", "label", "content-warning"]` tags
  - Confirmed (green), rejected (strikethrough red), pending (gray)
  - Summary count of confirmed/rejected/pending labels

- **Request logging** - Enhanced observability with request IDs
  - Unique request ID for each API call
  - Timing information for performance monitoring
  - Detailed logs for category verification workflow

### Changed
- Dashboard video cards now show verification buttons for each detected category
- Scores section has "AI Detections" header with "✓ Confirm · ✗ Reject" hint
- Toast notifications show label publish status and auto-approve feedback

### Configuration
- `MODERATOR_NSEC` - Nostr private key (hex) for signing label events
- `NOSTR_RELAY_URL` - Relay for publishing NIP-32 labels (e.g., wss://relay.divine.video)

---

## [1.1.0] - 2025-10-12

### Added
- **Admin bypass route** (`/admin/video/{sha256}.mp4`) - Authenticated admins can now view quarantined videos for review
  - Route requires valid session authentication
  - Fetches from Blossom server for admin review
  - Adds `X-Admin-Bypass: true` header for audit trail
  - Enables moderators to review flagged content and check for false positives
- **Comprehensive Sightengine model support** - Expanded moderation to use all 17 category models
  - Deepfake detection with configurable thresholds
  - Informational categories: alcohol, tobacco, gambling, destruction, military, medical, money
  - Text content moderation (OCR profanity detection)
  - QR code safety scanning
  - Weapon detection (firearms, knives, threats)
  - Drug detection (recreational drugs, medical substances)
  - Self-harm detection (critical ban category)
  - Enhanced gore classification with context (real/fake/animated)
  - Offensive content (hate symbols, gestures)

### Changed
- Dashboard video URLs now use admin bypass route instead of public CDN URLs
- All video previews in dashboard now work regardless of quarantine status
- Videos served with `Cache-Control: private, no-cache` to prevent caching of quarantined content
- **Classification system terminology** - Changed from "QUARANTINE" to "AGE_RESTRICTED" for high-severity content
- **Classifier logic** - Now handles all 17 Sightengine categories with individual thresholds
  - Permanent ban categories: self-harm (≥0.7), hate speech (≥0.8), extreme gore (≥0.95)
  - Age-restricted categories: nudity, violence, gore, weapons, drugs, alcohol, tobacco, gambling, destruction, AI-generated, deepfake
  - Review categories: informational content (medical, military, money, text profanity, QR codes) at ≥0.6 threshold
- **Sightengine API requests** - Now using comprehensive model list including nudity-2.1, gore-2.0, offensive-2.0, and 13 additional models

### Security
- Admin video route requires valid session token (401 for unauthenticated requests)
- Quarantined videos only accessible to authenticated moderators
- Public CDN continues to block quarantined content (HTTP 451)

### Testing
- Expanded test suite to 62 tests (from 40 tests)
- Added comprehensive tests for all 17 moderation categories
- Tests for permanent ban logic (self-harm, hate speech, extreme gore)
- Tests for informational category thresholds
- All tests passing with 100% success rate

## [1.0.0] - 2025-10-05

### Added
- **Complete video moderation pipeline** using Sightengine API
  - NSFW content detection (nudity, sexual content)
  - Violence detection (physical violence, weapons, gore)
  - AI-generated content detection
- **Three-tier classification system**
  - SAFE: Content approved for all audiences (scores < 0.6)
  - REVIEW: Borderline content flagged for human review (scores 0.6-0.8)
  - QUARANTINE: Harmful content immediately blocked (scores > 0.8)
- **Cloudflare Workers integration**
  - Queue-based asynchronous processing
  - KV storage for moderation results (90-day retention)
  - Blossom server integration for video access
- **Nostr event publishing** (NIP-56 kind 1984)
  - REVIEW cases flagged to human moderators
  - QUARANTINE cases logged for audit trail
  - Supports relay configuration via env var
- **Comprehensive test suite** (40 tests, 100% passing)
  - Unit tests for all components
  - Integration tests for full pipeline
  - TDD approach throughout development
- **Error handling and retry logic**
  - Automatic retry with exponential backoff (3 attempts)
  - Graceful degradation when Nostr publishing fails
  - Failed moderation logging to KV

### API Endpoints
- `POST /test-moderate` - Manually trigger moderation for a video
- `GET /check-result/{sha256}` - Check moderation result and quarantine status
- `GET /test-kv` - Test KV write capability

### Configuration
- Configurable thresholds for NSFW, violence, and AI-generated content
- CDN domain configuration
- Sightengine API credentials via secrets
- Nostr private key and relay URL via secrets

### Known Issues
- Nostr kind 1984 events currently blocked by relay3.openvine.co
  - Core moderation continues to work
  - Human review notifications temporarily unavailable
  - To be resolved with relay configuration update

### Performance
- Average processing time: ~10 seconds per 6-second video
- Sightengine analyzes 3-4 frames per video
- Queue supports batch processing (up to 10 videos)

### Security
- All moderation results stored in KV with hash-based keys
- Quarantine flags prevent CDN access to harmful content
- No sensitive data logged or exposed

### Deployment
- Deployed to Cloudflare Workers as `divine-moderation-service`
- Queue: `video-moderation-queue`
- KV Namespace: `eee0689974834390acd39d543002cac3`
- Blossom: `media.divine.video`
