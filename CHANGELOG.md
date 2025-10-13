# Changelog

All notable changes to the Divine Moderation Service will be documented in this file.

## [Unreleased] - 2025-10-12

### Added
- **Admin bypass route** (`/admin/video/{sha256}.mp4`) - Authenticated admins can now view quarantined videos for review
  - Route requires valid session authentication
  - Fetches directly from R2, bypassing CDN quarantine check
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
  - R2 bucket access for video retrieval
  - CDN integration with automatic quarantine blocking (HTTP 451)
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
- R2 Bucket: `nostrvine-media`
- CDN: `cdn.divine.video`
