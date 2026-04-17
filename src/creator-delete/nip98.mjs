// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-98 HTTP Authorization header validation for creator-delete endpoints.
// ABOUTME: Validates base64-encoded kind 27235 event with u, method tags, ±60s clock drift, signature.

import { verifyEvent } from 'nostr-tools/pure';

const CLOCK_DRIFT_SECONDS = 60;
const EXPECTED_KIND = 27235;

/**
 * Canonicalize a URL for NIP-98 `u` tag comparison. Normalizes forms that are
 * semantically equivalent but textually distinct so that a signed `u` tag from
 * a well-behaved client matches the request URL we build server-side.
 *
 * Explicit behaviors this helper performs:
 * - Strip fragment (never reaches the server).
 * - Strip userinfo (see comment at the assignment below).
 *
 * Behaviors the WHATWG URL constructor performs for us (stable across every
 * JS runtime that hosts CF Workers):
 * - Lowercase scheme and host.
 * - Strip explicit default ports (`:443` on https, `:80` on http).
 * - Normalize a bare root (`https://x`) to `https://x/`.
 *
 * What does NOT normalize (documented behavior — signer and verifier must agree):
 * - Non-root trailing slash (`/path` vs `/path/` are distinct resources).
 * - Query parameter ordering.
 * - Percent-encoding of reserved or unreserved characters (the URL constructor
 *   preserves the encoding as-received). If a signer produces `%7E` and the
 *   request URL has `~`, they will not match. Clients should build both sides
 *   with the same serialization; the typical path is `new URL(x).toString()`.
 *
 * Returns `null` if the input cannot be parsed as a URL. Callers must treat
 * `null === null` as a mismatch, not a match.
 */
function normalizeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    // Strip userinfo. API auth URLs never carry credentials, so a signed
    // `https://user@host/path` is treated as equivalent to `https://host/path`.
    // Intentional: clients that accidentally include userinfo in their signed
    // `u` tag should still match the server's clean expected URL. A malicious
    // signer cannot exploit this to forge auth because the signature is bound
    // to the original event (including the original u tag), not to the
    // normalized form used only for comparison.
    u.username = '';
    u.password = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

export async function validateNip98Header(authorizationHeader, expectedUrl, expectedMethod) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Nostr ')) {
    return { valid: false, error: 'Missing or malformed Authorization header (expected "Nostr <base64>")' };
  }

  const encoded = authorizationHeader.slice('Nostr '.length).trim();

  let event;
  try {
    const decoded = atob(encoded);
    event = JSON.parse(decoded);
  } catch (e) {
    return { valid: false, error: `Invalid base64 or JSON in Authorization header: ${e.message}` };
  }

  if (event.kind !== EXPECTED_KIND) {
    return { valid: false, error: `Expected kind ${EXPECTED_KIND}, got ${event.kind}` };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > CLOCK_DRIFT_SECONDS) {
    return { valid: false, error: `created_at ${event.created_at} outside ±${CLOCK_DRIFT_SECONDS}s window (server now: ${now})` };
  }

  if (!Array.isArray(event.tags)) {
    return { valid: false, error: 'Event missing tags array' };
  }

  const uTag = event.tags.find(t => t[0] === 'u')?.[1];
  const methodTag = event.tags.find(t => t[0] === 'method')?.[1];

  const normalizedUTag = normalizeUrl(uTag);
  const normalizedExpectedUrl = normalizeUrl(expectedUrl);
  if (
    normalizedUTag === null ||
    normalizedExpectedUrl === null ||
    normalizedUTag !== normalizedExpectedUrl
  ) {
    return {
      valid: false,
      error: `u tag '${uTag}' does not match expected URL '${expectedUrl}' after canonicalization`,
    };
  }

  if ((methodTag || '').toUpperCase() !== expectedMethod.toUpperCase()) {
    return { valid: false, error: `method tag '${methodTag}' does not match expected method '${expectedMethod}'` };
  }

  if (!verifyEvent(event)) {
    return { valid: false, error: 'Signature verification failed' };
  }

  return { valid: true, pubkey: event.pubkey };
}

// Exported for tests so callers can pin behavior without invoking the full
// validator.
export { normalizeUrl };
