# Admin Playback Bypass Design

## Summary

Moderation surfaces should always be able to play the video they are reviewing, even when the public CDN path returns `404` due to enforcement. The worker already exposes an authenticated admin proxy at `/admin/video/:sha.mp4` that falls back to Blossom's admin blob endpoint when public serving is blocked. The bug is that several moderation views still point `<video>` elements at public `media.divine.video` URLs instead of the admin proxy.

This change makes moderation playback consistently use the admin proxy for all rendered players and preloaders. It does not change moderation policy, queue semantics, or what copy/share buttons expose.

## Goals

- Ensure every video shown inside moderation can play regardless of public CDN restrictions.
- Scope the change to playback only.
- Reuse the existing authenticated `/admin/video/:sha.mp4` route instead of adding a new bypass mechanism.

## Non-Goals

- Changing public serving behavior.
- Changing `/admin/review` queue semantics.
- Changing copy/share/public URL affordances in the UI.
- Changing moderation decisions or enforcement policy.

## Current Problem

The moderation worker already has an auth-protected admin proxy route that:

1. Tries the public CDN first.
2. Falls back to Blossom's admin blob endpoint when the public path is restricted.

However, the admin UIs are inconsistent:

- Dashboard triage cards use `cdnUrl` or a direct `media.divine.video` URL.
- Swipe review uses direct public URLs for untriaged item preload and playback.
- Some dashboard playback code keeps a non-canonical `cdnUrl` instead of normalizing to the admin proxy.

When those public paths are blocked, moderators see broken players even though the server has a working bypass.

## Proposed Design

### Playback rule

For any video rendered inside the moderation UI, the source URL must be:

`/admin/video/<sha256>.mp4`

This applies to:

- dashboard triage cards
- dashboard lookup/detail playback
- swipe review cards
- swipe review preloaders

### Metadata rule

Existing `cdnUrl`, imported stable URLs, and public blob URLs remain available as metadata. They are not removed from API payloads and can still be used by copy/share controls if needed. They just stop being the source of moderator playback.

### Backend rule

The existing `/admin/video/:sha.mp4` route remains the single playback path. No new backend endpoint is needed unless tests reveal a gap in the current fallback behavior.

## Testing Strategy

Add regression coverage for:

- the admin proxy route falling back to the authenticated Blossom admin endpoint when the public CDN fetch returns `404`
- dashboard playback URL generation using `/admin/video/:sha.mp4`
- swipe review playback URL generation using `/admin/video/:sha.mp4` for both rendered cards and preloaded videos

## Expected Outcome

Moderators can watch any video surfaced by the moderation UI, even when public playback is blocked. Public users still see existing enforcement behavior unchanged.
