// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM sender module (dm-sender.mjs)
// ABOUTME: Verifies message templates, key derivation, rate limiting, and relay discovery

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import {
  getMessageForAction,
  getReportOutcomeMessage,
  getModeratorKeys,
  checkRateLimit,
  discoverUserRelays,
  sendModerationDM,
  selectTemplate
} from './dm-sender.mjs';

// Generate a stable test nsec for use across tests
const testSecretKey = generateSecretKey();
const testNsec = nsecEncode(testSecretKey);
const testPubkey = getPublicKey(testSecretKey);

describe('DM Sender - Message Templates', () => {
  it('should produce correct message for PERMANENT_BAN', () => {
    const message = getMessageForAction('PERMANENT_BAN', 'explicit content');

    expect(message).toContain('removed');
    expect(message).toContain('explicit content');
    expect(message).toContain('appeal');
  });

  it('should produce correct message for AGE_RESTRICTED', () => {
    const message = getMessageForAction('AGE_RESTRICTED', 'mature themes');

    expect(message).toContain('age-restricted');
    expect(message).toContain('mature themes');
    expect(message).toContain('confirmed their age');
  });

  it('should produce correct message for QUARANTINE', () => {
    const message = getMessageForAction('QUARANTINE', 'potential violation');

    expect(message).toContain('temporarily hidden');
    expect(message).toContain('potential violation');
    expect(message).toContain('review');
  });

  it('should return null for unknown action', () => {
    const message = getMessageForAction('UNKNOWN_ACTION', 'test');
    expect(message).toBeNull();
  });

  it('should use default reason when none provided', () => {
    const message = getMessageForAction('PERMANENT_BAN');
    expect(message).toContain('content policy violation');
  });

  it('should produce correct report outcome message', () => {
    const message = getReportOutcomeMessage('removed');

    expect(message).toContain('Thank you');
    expect(message).toContain('removed');
    expect(message).toContain('community safe');
  });
});

describe('DM Sender - getModeratorKeys', () => {
  it('should derive correct pubkey from nsec', () => {
    const env = { MODERATOR_NSEC: testNsec };
    const { privateKey, publicKey } = getModeratorKeys(env);

    expect(publicKey).toBe(testPubkey);
    expect(privateKey).toBeInstanceOf(Uint8Array);
    expect(privateKey.length).toBe(32);
  });

  it('should throw when MODERATOR_NSEC is missing', () => {
    expect(() => getModeratorKeys({})).toThrow('MODERATOR_NSEC not configured');
  });

  it('should produce consistent results', () => {
    const env = { MODERATOR_NSEC: testNsec };
    const keys1 = getModeratorKeys(env);
    const keys2 = getModeratorKeys(env);

    expect(keys1.publicKey).toBe(keys2.publicKey);
  });
});

describe('DM Sender - Rate Limiting', () => {
  let mockKV;
  let env;

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn()
    };
    env = { MODERATION_KV: mockKV };
  });

  it('should allow first DM (no existing rate limit)', async () => {
    mockKV.get.mockResolvedValue(null);

    const allowed = await checkRateLimit('b'.repeat(64), env);

    expect(allowed).toBe(true);
    expect(mockKV.get).toHaveBeenCalledWith(`dm-ratelimit:${'b'.repeat(64)}`);
  });

  it('should allow when under limit', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Simulate 3 recent timestamps
    mockKV.get.mockResolvedValue(JSON.stringify([now - 10, now - 20, now - 30]));

    const allowed = await checkRateLimit('b'.repeat(64), env);

    expect(allowed).toBe(true);
  });

  it('should block the 6th DM within the rate limit window', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Simulate 5 recent timestamps (at the limit)
    mockKV.get.mockResolvedValue(JSON.stringify([now - 5, now - 10, now - 15, now - 20, now - 25]));

    const allowed = await checkRateLimit('b'.repeat(64), env);

    expect(allowed).toBe(false);
  });

  it('should allow DMs when no KV is configured', async () => {
    const envNoKV = {};
    const allowed = await checkRateLimit('b'.repeat(64), envNoKV);
    expect(allowed).toBe(true);
  });

  it('should use recipient pubkey in the rate limit key', async () => {
    const recipientPubkey = 'c'.repeat(64);
    mockKV.get.mockResolvedValue(null);

    await checkRateLimit(recipientPubkey, env);

    expect(mockKV.get).toHaveBeenCalledWith(`dm-ratelimit:${recipientPubkey}`);
  });
});

describe('DM Sender - discoverUserRelays', () => {
  let mockKV;
  let env;

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn()
    };
    env = { MODERATION_KV: mockKV };
  });

  it('should return cached relays from KV', async () => {
    const cachedRelays = ['wss://relay1.example.com', 'wss://relay2.example.com'];
    mockKV.get.mockResolvedValue(JSON.stringify(cachedRelays));

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toEqual(cachedRelays);
    expect(mockKV.get).toHaveBeenCalledWith(expect.stringContaining('relay-list:'));
  });

  it('should fall back to default relays when no cache and no relay list', async () => {
    mockKV.get.mockResolvedValue(null);
    // No WebSocket available in test — fetchRelayList will throw

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays.length).toBeGreaterThan(0);
    expect(relays.length).toBeLessThanOrEqual(5);
    // Should include divine relay as default
    expect(relays).toContain('wss://relay.divine.video');
  });

  it('should cap relays at 5', async () => {
    const manyRelays = [
      'wss://r1.example.com', 'wss://r2.example.com', 'wss://r3.example.com',
      'wss://r4.example.com', 'wss://r5.example.com', 'wss://r6.example.com',
      'wss://r7.example.com'
    ];
    mockKV.get.mockResolvedValue(JSON.stringify(manyRelays));

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays.length).toBeLessThanOrEqual(5);
  });

  it('should work when KV is not configured', async () => {
    const envNoKV = {};

    const relays = await discoverUserRelays('b'.repeat(64), envNoKV);

    expect(relays.length).toBeGreaterThan(0);
  });
});

describe('DM Sender - Error Handling', () => {
  it('should not throw when MODERATOR_NSEC is missing', async () => {
    const env = {};
    const ctx = { waitUntil: vi.fn() };

    // sendModerationDM should not throw
    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test', env, ctx);
    expect(result).toBeDefined();
    expect(result.sent).toBe(false);
  });

  it('should not throw when rate limited', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockKV = {
      get: vi.fn().mockResolvedValue(JSON.stringify([now - 1, now - 2, now - 3, now - 4, now - 5])),
      put: vi.fn()
    };
    const env = {
      MODERATOR_NSEC: testNsec,
      MODERATION_KV: mockKV
    };
    const ctx = { waitUntil: vi.fn() };

    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test', env, ctx);
    expect(result).toBeDefined();
    expect(result.sent).toBe(false);
  });

  it('should not throw when relay connection fails', async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn()
    };
    const env = {
      MODERATOR_NSEC: testNsec,
      MODERATION_KV: mockKV
      // No BLOSSOM_DB — will skip D1 logging
    };
    const ctx = { waitUntil: vi.fn() };

    // This will fail on WebSocket connect but should catch gracefully
    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test reason', env, ctx);
    // Should not throw — either succeeds or returns failure gracefully
    expect(result).toBeDefined();
  });
});

describe('DM Sender - selectTemplate (Category-Specific)', () => {
  it('should include policy link and specific reason for nudity category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"nudity": 0.95}');

    expect(msg).toContain('sexual or nude content');
    expect(msg).toContain('https://divine.video/policies#sexual-content');
    expect(msg).toContain('appeal');
  });

  it('should include crisis hotline for self_harm category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"self_harm": 0.8}');

    expect(msg).toContain('self-harm');
    expect(msg).toContain('988');
    expect(msg).toContain('https://divine.video/policies#self-harm');
  });

  it('should fall back to custom reason when no category match', () => {
    const msg = selectTemplate('QUARANTINE', 'custom reason', null);

    expect(msg).toContain('custom reason');
    expect(msg).toContain('https://divine.video/policies');
  });

  it('should use default reason when no category and no reason', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, null);

    expect(msg).toContain('content policy violation');
    expect(msg).toContain('https://divine.video/policies');
  });

  it('should return null for unknown action', () => {
    const msg = selectTemplate('SAFE', null, null);
    expect(msg).toBeNull();
  });

  it('should handle plain string category', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, 'offensive');

    expect(msg).toContain('offensive or hateful content');
    expect(msg).toContain('https://divine.video/policies#hate-speech');
  });

  it('should handle ai_generated category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"ai_generated": 0.9}');

    expect(msg).toContain('AI-generated');
    expect(msg).toContain('https://divine.video/policies#ai-content');
  });

  it('should handle scam category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, 'scam');

    expect(msg).toContain('fraudulent or scam');
    expect(msg).toContain('https://divine.video/policies#fraud');
  });

  it('should produce AGE_RESTRICTED template', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, '{"nudity": 0.7}');

    expect(msg).toContain('age-restricted');
    expect(msg).toContain('confirmed their age');
  });

  it('should produce QUARANTINE template', () => {
    const msg = selectTemplate('QUARANTINE', null, '{"deepfake": 0.85}');

    expect(msg).toContain('temporarily hidden');
    expect(msg).toContain('manipulated media');
    expect(msg).toContain('reply with context');
  });
});
