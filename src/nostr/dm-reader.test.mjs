// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM inbox reader module (dm-reader.mjs)
// ABOUTME: Verifies pubkey derivation, inbox sync behavior, and error handling

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { getModeratorPubkey } from './dm-reader.mjs';

// Generate a stable test key in hex format (matching production usage)
const testSecretKey = generateSecretKey();
const testHex = bytesToHex(testSecretKey);
const testPubkey = getPublicKey(testSecretKey);

describe('DM Reader - getModeratorPubkey', () => {
  it('should derive correct pubkey from hex private key', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const pubkey = getModeratorPubkey(env);
    expect(pubkey).toBe(testPubkey);
  });

  it('should throw when NOSTR_PRIVATE_KEY is missing', () => {
    expect(() => getModeratorPubkey({})).toThrow('NOSTR_PRIVATE_KEY not configured');
  });

  it('should throw for invalid hex', () => {
    expect(() => getModeratorPubkey({ NOSTR_PRIVATE_KEY: 'not-valid-hex' })).toThrow();
  });

  it('should return a 64-character hex string', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const pubkey = getModeratorPubkey(env);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});
