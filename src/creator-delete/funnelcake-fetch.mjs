// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Funnelcake kind 5 fetch with read-after-write retry.
// ABOUTME: Handles the window between Funnelcake accept (NIP-01 OK) and async ClickHouse write.

const DEFAULT_RETRY_DELAYS_MS = [0, 100, 500, 1000, 2000];

export async function fetchKind5WithRetry(kind5_id, { fetchEventById, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
  for (const delay of retryDelaysMs) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const event = await fetchEventById(kind5_id);
    if (event) return event;
  }
  return null;
}
