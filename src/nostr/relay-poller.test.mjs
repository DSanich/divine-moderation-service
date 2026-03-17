// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for relay poller pure extraction functions
// ABOUTME: Tests extractSha256FromImeta and extractVideoUrlFromEvent

import { describe, it, expect } from 'vitest';
import { extractSha256FromImeta, extractVideoUrlFromEvent } from './relay-poller.mjs';

const VALID_SHA256 = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const VALID_SHA256_UPPER = 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890';

describe('extractSha256FromImeta', () => {
  it('extracts sha256 from imeta tag x parameter', () => {
    const event = {
      tags: [
        ['imeta', 'url https://cdn.example.com/video.mp4', 'm video/mp4', `x ${VALID_SHA256}`]
      ]
    };

    expect(extractSha256FromImeta(event)).toBe(VALID_SHA256);
  });

  it('extracts sha256 from standalone x tag', () => {
    const event = {
      tags: [
        ['title', 'Test Video'],
        ['x', VALID_SHA256]
      ]
    };

    expect(extractSha256FromImeta(event)).toBe(VALID_SHA256);
  });

  it('lowercases uppercase sha256 from imeta tag', () => {
    const event = {
      tags: [
        ['imeta', `x ${VALID_SHA256_UPPER}`]
      ]
    };

    expect(extractSha256FromImeta(event)).toBe(VALID_SHA256_UPPER.toLowerCase());
  });

  it('lowercases uppercase sha256 from x tag', () => {
    const event = {
      tags: [
        ['x', VALID_SHA256_UPPER]
      ]
    };

    expect(extractSha256FromImeta(event)).toBe(VALID_SHA256_UPPER.toLowerCase());
  });

  it('returns null when no sha256 found', () => {
    const event = {
      tags: [
        ['title', 'Test Video'],
        ['r', 'https://example.com/video.mp4']
      ]
    };

    expect(extractSha256FromImeta(event)).toBeNull();
  });

  it('returns null for event with empty tags', () => {
    const event = { tags: [] };
    expect(extractSha256FromImeta(event)).toBeNull();
  });

  it('returns null for null event', () => {
    expect(extractSha256FromImeta(null)).toBeNull();
  });

  it('returns null for event without tags property', () => {
    expect(extractSha256FromImeta({})).toBeNull();
  });

  it('rejects invalid sha256 (too short)', () => {
    const event = {
      tags: [['x', 'abcdef1234']]
    };

    expect(extractSha256FromImeta(event)).toBeNull();
  });

  it('rejects invalid sha256 (non-hex characters)', () => {
    const event = {
      tags: [['x', 'zzzzzz1234567890zzzzzz1234567890zzzzzz1234567890zzzzzz1234567890']]
    };

    expect(extractSha256FromImeta(event)).toBeNull();
  });

  it('prefers imeta x param over standalone x tag', () => {
    const imetaSha = '1111111111111111111111111111111111111111111111111111111111111111';
    const xTagSha = '2222222222222222222222222222222222222222222222222222222222222222';
    const event = {
      tags: [
        ['imeta', `x ${imetaSha}`],
        ['x', xTagSha]
      ]
    };

    expect(extractSha256FromImeta(event)).toBe(imetaSha);
  });
});

describe('extractVideoUrlFromEvent', () => {
  it('extracts URL from imeta url parameter', () => {
    const event = {
      tags: [
        ['imeta', 'url https://cdn.example.com/video.mp4', 'm video/mp4', `x ${VALID_SHA256}`]
      ]
    };

    expect(extractVideoUrlFromEvent(event, {})).toBe('https://cdn.example.com/video.mp4');
  });

  it('falls back to r tag for URL', () => {
    const event = {
      tags: [
        ['r', 'https://cdn.example.com/video.mp4'],
        ['title', 'Test']
      ]
    };

    expect(extractVideoUrlFromEvent(event, {})).toBe('https://cdn.example.com/video.mp4');
  });

  it('constructs URL from sha256 and CDN_DOMAIN as last resort', () => {
    const event = {
      tags: [
        ['x', VALID_SHA256]
      ]
    };
    const env = { CDN_DOMAIN: 'cdn.divine.video' };

    expect(extractVideoUrlFromEvent(event, env)).toBe(`https://cdn.divine.video/${VALID_SHA256}`);
  });

  it('prefers imeta URL over r tag', () => {
    const event = {
      tags: [
        ['r', 'https://old.server.com/video'],
        ['imeta', 'url https://blossom.server.com/abc123', 'm video/mp4']
      ]
    };

    expect(extractVideoUrlFromEvent(event, {})).toBe('https://blossom.server.com/abc123');
  });

  it('returns null for null event', () => {
    expect(extractVideoUrlFromEvent(null, {})).toBeNull();
  });

  it('returns null for event without tags', () => {
    expect(extractVideoUrlFromEvent({}, {})).toBeNull();
  });

  it('returns null when no URL source available and no CDN_DOMAIN', () => {
    const event = {
      tags: [
        ['x', VALID_SHA256]
      ]
    };

    expect(extractVideoUrlFromEvent(event, {})).toBeNull();
  });

  it('ignores r tags that do not start with http', () => {
    const event = {
      tags: [
        ['r', 'not-a-url']
      ]
    };

    expect(extractVideoUrlFromEvent(event, {})).toBeNull();
  });

  it('extracts blossom URL without file extension from imeta', () => {
    const event = {
      tags: [
        ['imeta', `url https://blossom.example.com/${VALID_SHA256}`, 'm video/mp4']
      ]
    };

    expect(extractVideoUrlFromEvent(event, {})).toBe(`https://blossom.example.com/${VALID_SHA256}`);
  });
});
