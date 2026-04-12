# Admin video proxy: forward Range headers

## Problem
Videos render as a black 0:00 frame in the moderation admin dashboard. Browsers
(Safari, Chrome) send `Range: bytes=0-` on `<video>` element playback and require
`206 Partial Content` responses with `Content-Range` / `Accept-Ranges` headers. The
admin proxy handler at `src/index.mjs` (`/admin/video/:sha256.mp4`) currently does
not forward the `Range` header to any of its three upstream branches (CDN, transcoded
720p CDN variant, admin bypass), and does not pass through `206` status or the
accompanying range/length headers.

PR #77 (commit `c2921f2`) partially fixed the admin-bypass branch only. The CDN
and transcode branches remain broken for content that is served directly from CDN.

## Scope
- `src/index.mjs` — modify ONLY the three upstream `fetch(...)` calls inside the
  `/admin/video/` handler and their corresponding `new Response(...)` headers.
- `src/index.test.mjs` — add tests for range forwarding.

Do not refactor the CDN / transcode / bypass branching. Do not touch other routes.

## Changes

### Request-side (forward to upstream)
For each of the three upstream fetches, forward these request headers when present:
- `Range`
- `If-Range`
- `If-None-Match`
- `If-Modified-Since`

Extract a small helper `buildRangeRequestInit(request, extraHeaders)` scoped to
the handler (local const/function) so it can be reused by the CDN, transcode, and
admin-bypass fetches without refactoring the branching.

### Response-side (pass through to client)
For each of the three upstream response paths, when upstream status is 200 OR 206:
- Preserve upstream status (`status: upstream.status`).
- Pass through `Content-Range`, `Accept-Ranges`, `Content-Length`, `ETag`,
  `Last-Modified` when present.
- Keep existing `X-Admin-Proxy` tag value and `Cache-Control: private, no-store`.
- Still accept 206 as "ok" (the CDN branch currently uses `cdnResponse.ok` which
  is true for 200-299, so 206 already matches — but tighten checks where needed).

## Tests
Add to `src/index.test.mjs` in a new `describe('admin video proxy range forwarding', ...)`:

1. `forwards Range header to CDN and returns 206 with Content-Range` — CDN mock
   asserts received `Range: bytes=0-1023`, responds 206 with `Content-Range`;
   handler returns 206 with same headers and `X-Admin-Proxy: cdn`.
2. `forwards Range header to admin bypass branch and returns 206` — CDN miss (404),
   bypass mock asserts received Range + Authorization, responds 206; handler
   returns 206 with `X-Admin-Proxy: blossom-admin`.
3. `serves 200 when no Range header present` — existing behavior preserved.
4. `returns 404 when both CDN and bypass miss` — existing 404 fallthrough preserved.

## Verification
- `npm test` — all 303+ tests pass (new tests included).
