// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM sender module (dm-sender.mjs)
// ABOUTME: Verifies message templates, key derivation, rate limiting, and relay discovery

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import {
  getMessageForAction,
  getReportOutcomeMessage,
  getModeratorKeys,
  checkRateLimit,
  discoverUserRelays,
  sendModerationDM,
  selectTemplate
} from './dm-sender.mjs';

// Generate a stable test key in hex format (matching production usage)
const testSecretKey = generateSecretKey();
const testHex = bytesToHex(testSecretKey);
const testPubkey = getPublicKey(testSecretKey);

describe('DM Sender - Message Templates', () => {
  it('should produce correct message for PERMANENT_BAN', () => {
    const message = getMessageForAction('PERMANENT_BAN', 'contain explicit content', 'abc123');

    expect(message).toContain('Your content was removed');
    expect(message).toContain('contain explicit content');
    expect(message).toContain('reply to this message to appeal');
    expect(message).toContain('divine.video/video/abc123');
    expect(message).toContain('about.divine.video/faqs/');
    expect(message).toContain('divine.video/support');
  });

  it('should produce correct message for AGE_RESTRICTED', () => {
    const message = getMessageForAction('AGE_RESTRICTED', 'contain mature themes', 'def456');

    expect(message).toContain('age-restricted');
    expect(message).toContain('contain mature themes');
    expect(message).toContain('confirmed their age');
    expect(message).toContain('divine.video/video/def456');
  });

  it('should produce correct message for QUARANTINE', () => {
    const message = getMessageForAction('QUARANTINE', 'potential violation', 'ghi789');

    expect(message).toContain('temporarily hidden');
    expect(message).toContain('moderator will take a look');
    expect(message).toContain('divine.video/video/ghi789');
  });

  it('should return null for unknown action', () => {
    const message = getMessageForAction('UNKNOWN_ACTION', 'test');
    expect(message).toBeNull();
  });

  it('should use default reason when none provided', () => {
    const message = getMessageForAction('PERMANENT_BAN');
    expect(message).toContain('community guidelines');
  });

  it('should produce correct report outcome message', () => {
    const message = getReportOutcomeMessage('removed');

    expect(message).toContain('Thank you');
    expect(message).toContain('removed');
    expect(message).toContain('community safe');
  });
});

describe('DM Sender - getModeratorKeys', () => {
  it('should derive correct pubkey from hex private key', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const { privateKey, publicKey } = getModeratorKeys(env);

    expect(publicKey).toBe(testPubkey);
    expect(privateKey).toBeInstanceOf(Uint8Array);
    expect(privateKey.length).toBe(32);
  });

  it('should throw when NOSTR_PRIVATE_KEY is missing', () => {
    expect(() => getModeratorKeys({})).toThrow('NOSTR_PRIVATE_KEY not configured');
  });

  it('should cache keys for the same env object', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const keys1 = getModeratorKeys(env);
    const keys2 = getModeratorKeys(env);

    expect(keys1).toBe(keys2); // same reference, not just equal
  });

  it('should produce different keys for different env objects', () => {
    const otherKey = generateSecretKey();
    const env1 = { NOSTR_PRIVATE_KEY: testHex };
    const env2 = { NOSTR_PRIVATE_KEY: bytesToHex(otherKey) };

    const keys1 = getModeratorKeys(env1);
    const keys2 = getModeratorKeys(env2);

    expect(keys1.publicKey).not.toBe(keys2.publicKey);
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
  it('should return failure when NOSTR_PRIVATE_KEY is missing', async () => {
    const env = {};
    const ctx = { waitUntil: vi.fn() };

    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test', env, ctx);
    expect(result).toBeDefined();
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('NOSTR_PRIVATE_KEY');
  });

  it('should not throw when rate limited', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockKV = {
      get: vi.fn().mockResolvedValue(JSON.stringify([now - 1, now - 2, now - 3, now - 4, now - 5])),
      put: vi.fn()
    };
    const env = {
      NOSTR_PRIVATE_KEY: testHex,
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
      NOSTR_PRIVATE_KEY: testHex,
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
  it('should include specific reason for nudity category and content link', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"nudity": 0.95}', 'abc123');

    expect(msg).toContain('sexual or nude content');
    expect(msg).toContain('divine.video/video/abc123');
    expect(msg).toContain('reply to this message to appeal');
    expect(msg).toContain('about.divine.video/faqs/');
    expect(msg).not.toContain('https://divine.video/policies#sexual-content');
  });

  it('should include crisis hotline for self_harm category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"self_harm": 0.8}', 'abc123');

    expect(msg).toContain('self-harm');
    expect(msg).toContain('988');
    expect(msg).not.toContain('https://divine.video/policies#self-harm');
  });

  it('should ignore caller-provided reason for QUARANTINE (intentional)', () => {
    const msg = selectTemplate('QUARANTINE', 'custom reason', null, 'abc123');

    // QUARANTINE template is generic per spec — reason param is unused
    expect(msg).toContain('temporarily hidden');
    expect(msg).not.toContain('custom reason');
  });

  it('should use per-action default reason when no category and no reason (PERMANENT_BAN)', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, null, 'abc123');

    expect(msg).toContain('community guidelines');
    expect(msg).toContain('divine.video/video/abc123');
  });

  it('should use per-action default reason for AGE_RESTRICTED', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, null, 'abc123');

    expect(msg).toContain('not be suitable for all audiences');
    expect(msg).toContain('divine.video/video/abc123');
  });

  it('should ignore raw caller reason in favor of per-action default', () => {
    // Callers like index.mjs pass freeform reasons like "Manual moderator action"
    // which don't fit the "was found to {reason}" grammar. selectTemplate ignores them.
    const msg = selectTemplate('PERMANENT_BAN', 'Manual moderator action', null, 'abc123');

    expect(msg).not.toContain('Manual moderator action');
    expect(msg).toContain('community guidelines');
  });

  it('should return null for unknown action', () => {
    const msg = selectTemplate('SAFE', null, null, 'abc123');
    expect(msg).toBeNull();
  });

  it('should handle plain string category', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, 'offensive', 'abc123');

    expect(msg).toContain('offensive or hateful content');
    expect(msg).toContain('divine.video/video/abc123');
  });

  it('should handle ai_generated category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"ai_generated": 0.9}', 'abc123');

    expect(msg).toContain('AI-generated');
    expect(msg).not.toContain('https://divine.video/policies#ai-content');
  });

  it('should handle scam category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, 'scam', 'abc123');

    expect(msg).toContain('fraudulent or scam');
  });

  it('should produce AGE_RESTRICTED template with content link', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, '{"nudity": 0.7}', 'def456');

    expect(msg).toContain('age-restricted');
    expect(msg).toContain('confirmed their age');
    expect(msg).toContain('divine.video/video/def456');
  });

  it('should produce QUARANTINE template with reply invitation', () => {
    const msg = selectTemplate('QUARANTINE', null, '{"deepfake": 0.85}', 'ghi789');

    expect(msg).toContain('temporarily hidden');
    expect(msg).toContain('reply to this message');
    expect(msg).toContain('divine.video/video/ghi789');
  });

  it('should append crisis hotline to AGE_RESTRICTED for self_harm', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, '{"self_harm": 0.8}', 'abc123');

    expect(msg).toContain('age-restricted');
    expect(msg).toContain('988');
  });

  it('should handle missing sha256 gracefully', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, null, null);

    expect(msg).toContain('divine.video/video/unknown');
    expect(msg).toContain('community guidelines');
  });
});
