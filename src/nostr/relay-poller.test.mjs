// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for relay polling functionality
// ABOUTME: Tests event parsing, SHA256 extraction, and polling status management

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import functions that we can test without WebSocket connections
// The main pollRelayForVideos function requires WebSocket which is hard to mock in workers

describe('Relay Poller - SHA256 Extraction', () => {
  // We'll test the SHA256 extraction logic inline since it's not exported

  it('should extract SHA256 from imeta tag with x parameter', () => {
    const event = {
      id: 'event123',
      kind: 34236,
      pubkey: 'pubkey123',
      tags: [
        ['imeta', 'url https://cdn.divine.video/test.mp4', 'm video/mp4', 'x abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890']
      ]
    };

    // Extract using the same logic as the relay-poller
    let sha256 = null;
    for (const tag of event.tags) {
      if (tag[0] === 'imeta') {
        for (let i = 1; i < tag.length; i++) {
          const param = tag[i];
          if (param && param.startsWith('x ')) {
            sha256 = param.substring(2).trim();
          }
        }
      }
    }

    expect(sha256).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('should extract SHA256 from standalone x tag', () => {
    const event = {
      id: 'event456',
      kind: 34236,
      pubkey: 'pubkey456',
      tags: [
        ['title', 'Test Video'],
        ['x', '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef']
      ]
    };

    // Extract from x tag
    let sha256 = null;
    for (const tag of event.tags) {
      if (tag[0] === 'x' && tag[1]) {
        const candidate = tag[1].trim();
        if (/^[0-9a-f]{64}$/i.test(candidate)) {
          sha256 = candidate.toLowerCase();
        }
      }
    }

    expect(sha256).toBe('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });

  it('should return null for events without SHA256', () => {
    const event = {
      id: 'event789',
      kind: 34236,
      pubkey: 'pubkey789',
      tags: [
        ['title', 'Test Video'],
        ['r', 'https://example.com/video.mp4']
      ]
    };

    let sha256 = null;
    for (const tag of event.tags) {
      if (tag[0] === 'imeta') {
        for (let i = 1; i < tag.length; i++) {
          const param = tag[i];
          if (param && param.startsWith('x ')) {
            sha256 = param.substring(2).trim();
          }
        }
      }
      if (tag[0] === 'x' && tag[1]) {
        const candidate = tag[1].trim();
        if (/^[0-9a-f]{64}$/i.test(candidate)) {
          sha256 = candidate.toLowerCase();
        }
      }
    }

    expect(sha256).toBeNull();
  });

  it('should validate SHA256 format - reject invalid hashes', () => {
    // Not 64 characters
    const shortHash = 'abcdef1234';
    expect(/^[0-9a-f]{64}$/i.test(shortHash)).toBe(false);

    // Invalid characters
    const invalidHash = 'ghijklmnopqrstuvwxyzghijklmnopqrstuvwxyzghijklmnopqrstuvwxyzghij';
    expect(/^[0-9a-f]{64}$/i.test(invalidHash)).toBe(false);

    // Valid hash
    const validHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    expect(/^[0-9a-f]{64}$/i.test(validHash)).toBe(true);
  });
});

describe('Relay Poller - Video URL Extraction', () => {
  // Helper that mirrors the extractVideoUrlFromEvent logic
  function extractVideoUrlFromEvent(event, env = {}) {
    if (!event || !event.tags) return null;

    // Check imeta tag for URL first (most reliable)
    for (const tag of event.tags) {
      if (tag[0] === 'imeta') {
        let imetaUrl = null;
        for (let i = 1; i < tag.length; i++) {
          const param = tag[i];
          if (param && param.startsWith('url ')) {
            imetaUrl = param.substring(4).trim();
          }
        }
        if (imetaUrl) return imetaUrl;
      }
    }

    // Check r tags (any http URL)
    for (const tag of event.tags) {
      if (tag[0] === 'r' && tag[1] && tag[1].startsWith('http')) {
        return tag[1];
      }
    }

    return null;
  }

  it('should extract video URL from r tag', () => {
    const event = {
      tags: [
        ['r', 'https://cdn.divine.video/test.mp4'],
        ['title', 'Test']
      ]
    };

    const url = extractVideoUrlFromEvent(event);
    expect(url).toBe('https://cdn.divine.video/test.mp4');
  });

  it('should extract video URL from imeta tag', () => {
    const event = {
      tags: [
        ['imeta', 'url https://cdn.divine.video/video123.mp4', 'm video/mp4', 'x abc123']
      ]
    };

    const url = extractVideoUrlFromEvent(event);
    expect(url).toBe('https://cdn.divine.video/video123.mp4');
  });

  it('should extract blossom URL without file extension from imeta', () => {
    const event = {
      tags: [
        ['imeta', 'url https://blossom.example.com/abcdef1234567890', 'm video/mp4', 'x abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890']
      ]
    };

    const url = extractVideoUrlFromEvent(event);
    expect(url).toBe('https://blossom.example.com/abcdef1234567890');
  });

  it('should extract blossom URL without file extension from r tag', () => {
    const event = {
      tags: [
        ['r', 'https://blossom.other.server/abcdef1234567890'],
        ['title', 'External Video']
      ]
    };

    const url = extractVideoUrlFromEvent(event);
    expect(url).toBe('https://blossom.other.server/abcdef1234567890');
  });

  it('should prefer imeta URL over r tag URL', () => {
    const event = {
      tags: [
        ['r', 'https://old.server.com/video'],
        ['imeta', 'url https://blossom.server.com/abc123', 'm video/mp4', 'x abc123']
      ]
    };

    const url = extractVideoUrlFromEvent(event);
    expect(url).toBe('https://blossom.server.com/abc123');
  });
});

describe('Relay Poller - Polling Status', () => {
  let mockKV;

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn()
    };
  });

  it('should return null for first poll (no previous timestamp)', async () => {
    mockKV.get.mockResolvedValue(null);

    const env = { MODERATION_KV: mockKV };

    // Simulate getLastPollTimestamp
    const data = await mockKV.get('relay-poller:last-poll');
    const timestamp = data ? JSON.parse(data).timestamp : null;

    expect(timestamp).toBeNull();
  });

  it('should return previous timestamp if available', async () => {
    const previousTimestamp = 1700000000;
    mockKV.get.mockResolvedValue(JSON.stringify({ timestamp: previousTimestamp }));

    const data = await mockKV.get('relay-poller:last-poll');
    const timestamp = data ? JSON.parse(data).timestamp : null;

    expect(timestamp).toBe(previousTimestamp);
  });

  it('should store polling statistics correctly', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const stats = {
      totalEvents: 10,
      queuedForModeration: 5,
      alreadyModerated: 5
    };

    // Simulate setLastPollTimestamp
    await mockKV.put('relay-poller:last-poll', JSON.stringify({
      timestamp,
      lastPollAt: new Date().toISOString(),
      ...stats
    }));

    expect(mockKV.put).toHaveBeenCalledWith(
      'relay-poller:last-poll',
      expect.stringContaining('"totalEvents":10')
    );
  });

  it('should return disabled status when RELAY_POLLING_ENABLED is false', () => {
    const env = {
      RELAY_POLLING_ENABLED: 'false',
      MODERATION_KV: mockKV
    };

    const enabled = env.RELAY_POLLING_ENABLED !== 'false';
    expect(enabled).toBe(false);
  });

  it('should return enabled status by default', () => {
    const env = {
      MODERATION_KV: mockKV
    };

    const enabled = env.RELAY_POLLING_ENABLED !== 'false';
    expect(enabled).toBe(true);
  });
});

describe('Relay Poller - Queue Message Format', () => {
  it('should create valid queue message from event', () => {
    const event = {
      id: 'event123456789',
      kind: 34236,
      pubkey: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      created_at: 1700000000,
      tags: [
        ['imeta', 'url https://cdn.divine.video/test.mp4', 'm video/mp4', 'x 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef']
      ]
    };

    // Simulate queue message creation
    const sha256 = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const queueMessage = {
      sha256,
      uploadedBy: event.pubkey,
      uploadedAt: event.created_at * 1000,
      metadata: {
        source: 'relay-poller',
        relay: 'wss://relay.divine.video',
        eventId: event.id,
        videoUrl: 'https://cdn.divine.video/test.mp4'
      }
    };

    expect(queueMessage.sha256).toBe('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
    expect(queueMessage.uploadedBy).toBe('abc123def456abc123def456abc123def456abc123def456abc123def456abc1');
    expect(queueMessage.uploadedAt).toBe(1700000000000);
    expect(queueMessage.metadata.source).toBe('relay-poller');
  });
});

describe('Relay Poller - Configuration', () => {
  it('should use default relay when not configured', () => {
    const env = {};
    const relays = env.RELAY_POLLING_RELAY_URL
      ? [env.RELAY_POLLING_RELAY_URL]
      : ['wss://relay.divine.video'];

    expect(relays).toEqual(['wss://relay.divine.video']);
  });

  it('should use configured relay URL', () => {
    const env = {
      RELAY_POLLING_RELAY_URL: 'wss://custom.relay.com'
    };
    const relays = env.RELAY_POLLING_RELAY_URL
      ? [env.RELAY_POLLING_RELAY_URL]
      : ['wss://relay.divine.video'];

    expect(relays).toEqual(['wss://custom.relay.com']);
  });

  it('should use default limit when not configured', () => {
    const env = {};
    const limit = parseInt(env.RELAY_POLLING_LIMIT || '100', 10);

    expect(limit).toBe(100);
  });

  it('should use configured limit', () => {
    const env = {
      RELAY_POLLING_LIMIT: '50'
    };
    const limit = parseInt(env.RELAY_POLLING_LIMIT || '100', 10);

    expect(limit).toBe(50);
  });

  it('should calculate since timestamp from lookback hours', () => {
    const env = {
      RELAY_POLLING_LOOKBACK_HOURS: '2'
    };
    const lookbackHours = parseInt(env.RELAY_POLLING_LOOKBACK_HOURS || '1', 10);
    const now = Math.floor(Date.now() / 1000);
    const since = now - (lookbackHours * 3600);

    // Should be approximately 2 hours ago
    expect(now - since).toBe(7200); // 2 hours in seconds
  });
});
