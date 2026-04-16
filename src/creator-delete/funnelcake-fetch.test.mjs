// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for fetchKind5WithRetry — retry loop + terminal null-result.
// ABOUTME: Uses vi.fn mocks; no relay calls, no delays longer than a few ms.

import { describe, it, expect, vi } from 'vitest';
import { fetchKind5WithRetry } from './funnelcake-fetch.mjs';

describe('fetchKind5WithRetry', () => {
  it('returns event after two nulls then success', async () => {
    const underlying = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'k1', kind: 5 });
    const result = await fetchKind5WithRetry('k1', { fetchEventById: underlying, retryDelaysMs: [0, 10, 20] });
    expect(result).toEqual({ id: 'k1', kind: 5 });
    expect(underlying).toHaveBeenCalledTimes(3);
  });

  it('returns null if all retries return null', async () => {
    const underlying = vi.fn().mockResolvedValue(null);
    const result = await fetchKind5WithRetry('k1', { fetchEventById: underlying, retryDelaysMs: [0, 10] });
    expect(result).toBeNull();
    expect(underlying).toHaveBeenCalledTimes(2);
  });
});
