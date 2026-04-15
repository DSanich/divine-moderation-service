// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared HTTP header parsing helpers

// Only the delta-seconds form of Retry-After is supported. The HTTP-date form
// (RFC 9110 §10.2.3) is not; Blossom emits integer seconds and that is the
// only producer we consume here.
export function parseRetryAfterSeconds(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getRetryAfterSecondsFromResponse(response) {
  if (typeof response?.headers?.get !== 'function') {
    return null;
  }
  return parseRetryAfterSeconds(response.headers.get('Retry-After'));
}
