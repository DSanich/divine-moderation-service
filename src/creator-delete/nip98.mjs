// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-98 HTTP Authorization header validation for creator-delete endpoints.
// ABOUTME: Validates base64-encoded kind 27235 event with u, method tags, ±60s clock drift, signature.

import { verifyEvent } from 'nostr-tools/pure';

const CLOCK_DRIFT_SECONDS = 60;
const EXPECTED_KIND = 27235;

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

  if (uTag !== expectedUrl) {
    return { valid: false, error: `u tag '${uTag}' does not match expected URL '${expectedUrl}'` };
  }

  if ((methodTag || '').toUpperCase() !== expectedMethod.toUpperCase()) {
    return { valid: false, error: `method tag '${methodTag}' does not match expected method '${expectedMethod}'` };
  }

  if (!verifyEvent(event)) {
    return { valid: false, error: 'Signature verification failed' };
  }

  return { valid: true, pubkey: event.pubkey };
}
