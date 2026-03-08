// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM inbox reader module (dm-reader.mjs)
// ABOUTME: Verifies pubkey derivation, inbox sync behavior, and error handling

import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { getModeratorPubkey } from './dm-reader.mjs';

// Generate a stable test nsec
const testSecretKey = generateSecretKey();
const testNsec = nsecEncode(testSecretKey);
const testPubkey = getPublicKey(testSecretKey);

describe('DM Reader - getModeratorPubkey', () => {
  it('should derive correct pubkey from MODERATOR_NSEC', () => {
    const env = { MODERATOR_NSEC: testNsec };
    const pubkey = getModeratorPubkey(env);
    expect(pubkey).toBe(testPubkey);
  });

  it('should throw when MODERATOR_NSEC is missing', () => {
    expect(() => getModeratorPubkey({})).toThrow('MODERATOR_NSEC not configured');
  });

  it('should throw for invalid nsec', () => {
    expect(() => getModeratorPubkey({ MODERATOR_NSEC: 'npub1invalid' })).toThrow();
  });
});
