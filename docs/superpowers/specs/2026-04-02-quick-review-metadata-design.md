# Quick Review Metadata-First Card

**Date:** 2026-04-02
**Status:** Approved
**Scope:** divine-moderation-service quick review UI and supporting admin API payloads

## Problem

The quick review card does not show enough post context to make moderation decisions quickly or confidently.

Current problems:
- The card emphasizes AI scores before publisher identity and post context.
- The top timestamp is effectively moderation time, which can be confused with publish time.
- Persisted metadata such as `author`, `title`, `event_id`, `content_url`, and `published_at` is not surfaced in the quick review queue payload.
- Extra metadata only appears opportunistically after an async lookup, so the card feels incomplete and inconsistent.

## User Intent

The moderator wants the card to answer these questions immediately, without collapsing anything:
- Who published this?
- When was it published?
- What did they say?
- What metadata exists for the video and event?

The moderator explicitly requested that all available context be visible by default.

## Design

Rebuild the quick review card as a metadata-first review surface.

### Layout

- Increase the maximum card width on desktop to support a two-column layout.
- Desktop layout:
  - Left column: video player
  - Right column: full metadata and review context
- Mobile layout:
  - Same sections in the same order
  - Stacked vertically with no hidden details

### Information Hierarchy

Show the following sections in this order:

1. Publisher identity
2. Post body and content metadata
3. Timeline
4. Technical identifiers and source metadata
5. Classifier summary
6. Transcript
7. Moderation scores and provider details
8. Review actions

### Publisher Identity

Show all available publisher identity fields at the top:
- `author` / display name
- uploader pubkey in full
- Divine profile link when a pubkey is known
- avatar initial fallback

If `author` is missing, fall back to uploader/pubkey-based labeling rather than leaving the section vague.

### Post Body And Content Metadata

Show all available post-level context:
- title
- full post text / event content
- Divine video link
- content/CDN URL
- original source URL when present

Content text should be fully visible by default with normal wrapping, not hidden behind a disclosure.

### Timeline

Show all known timestamps together with clear labels:
- `Published`
- `Received`
- `Moderated`
- `Reviewed`

Each timestamp should include absolute time and relative time when available.

Do not use moderation time as the only visible time field.

### Technical Identifiers And Source Metadata

Show all known technical metadata in a readable key/value grid:
- `event_id`
- `sha256`
- `provider`
- `platform`
- `client`
- `loops`
- `likes`
- `comments`
- `published_at`
- `archived_at`
- `imported_at`
- `vine_hash_id`
- `vine_user_id`

Only omit fields that are truly absent.

### API Changes

The quick review queue payload should include the metadata already persisted in `moderation_results` so the first render is complete:
- `title`
- `author`
- `event_id`
- `content_url`
- `published_at`

The single-video admin lookup route should also preserve or expose:
- `nostrContext.content`
- `nostrContext.sourceUrl`
- `nostrContext.platform`
- `nostrContext.client`
- `nostrContext.loops`
- `nostrContext.likes`
- `nostrContext.comments`
- `nostrContext.publishedAt`
- `nostrContext.archivedAt`
- `nostrContext.importedAt`
- `nostrContext.vineHashId`
- `nostrContext.vineUserId`

### Non-Goals

- No collapsible details panel
- No persistence of UI expansion state
- No change to moderation actions or queue semantics
- No redesign of dashboard pages outside quick review

## Implementation Notes

- Reuse persisted D1 metadata for fast first paint.
- Keep the async `/admin/api/video/:identifier` enrichment path for deeper or missing lookup metadata.
- Preserve existing escape/sanitization behavior for all user-sourced strings.
- Maintain mobile usability even with fully expanded metadata.

## Testing

Add coverage for:
- queue payload returning persisted metadata fields
- card rendering of publisher, post body, labeled timestamps, and technical metadata
- fallback behavior when some metadata is absent
- mobile-safe rendering helpers where practical via unit-level assertions
