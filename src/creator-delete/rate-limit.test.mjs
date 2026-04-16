// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for checkRateLimit — allow under limit, block over limit.
// ABOUTME: Uses in-memory fake KV (makeFakeKV) from ./test-helpers.mjs.

import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit } from './rate-limit.mjs';
import { makeFakeKV } from './test-helpers.mjs';

describe('checkRateLimit', () => {
  let kv;
  beforeEach(() => { kv = makeFakeKV(); });

  it('allows under the limit', async () => {
    const result = await checkRateLimit(kv, { key: 'pubkey:abc', limit: 5, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks over the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(kv, { key: 'pubkey:abc', limit: 5, windowSeconds: 60 });
    }
    const result = await checkRateLimit(kv, { key: 'pubkey:abc', limit: 5, windowSeconds: 60 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
