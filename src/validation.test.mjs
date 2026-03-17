// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for pure validation and parsing helpers
// ABOUTME: Covers SHA-256, pubkey, identifier validation and media event parsing

import { describe, expect, it } from 'vitest';
import {
  isValidSha256,
  isValidPubkey,
  isValidLookupIdentifier,
  parseMaybeJson,
  getEventTagValue,
  parseImetaParams,
  extractShaFromUrl,
  extractMediaShaFromEvent,
} from './validation.mjs';

const VALID_SHA = 'a'.repeat(64);
const VALID_SHA_UPPER = 'A'.repeat(64);
const VALID_SHA_MIXED = 'aAbBcCdDeEfF' + '0'.repeat(52);

describe('isValidSha256', () => {
  it('accepts valid lowercase hex string', () => {
    expect(isValidSha256(VALID_SHA)).toBe(true);
  });

  it('accepts valid uppercase hex string', () => {
    expect(isValidSha256(VALID_SHA_UPPER)).toBe(true);
  });

  it('accepts mixed-case hex string', () => {
    expect(isValidSha256(VALID_SHA_MIXED)).toBe(true);
  });

  it('rejects too-short hex string', () => {
    expect(isValidSha256('a'.repeat(63))).toBe(false);
  });

  it('rejects too-long hex string', () => {
    expect(isValidSha256('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidSha256('g'.repeat(64))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSha256('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidSha256(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidSha256(undefined)).toBe(false);
  });

  it('rejects number', () => {
    expect(isValidSha256(12345)).toBe(false);
  });
});

describe('isValidPubkey', () => {
  it('accepts valid 64-char hex pubkey', () => {
    expect(isValidPubkey(VALID_SHA)).toBe(true);
  });

  it('rejects invalid pubkey', () => {
    expect(isValidPubkey('not-a-pubkey')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidPubkey(null)).toBe(false);
  });
});

describe('isValidLookupIdentifier', () => {
  it('accepts valid short string', () => {
    expect(isValidLookupIdentifier('hello')).toBe(true);
  });

  it('accepts single character', () => {
    expect(isValidLookupIdentifier('x')).toBe(true);
  });

  it('accepts max length string (255)', () => {
    expect(isValidLookupIdentifier('a'.repeat(255))).toBe(true);
  });

  it('rejects over max length (256)', () => {
    expect(isValidLookupIdentifier('a'.repeat(256))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidLookupIdentifier('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidLookupIdentifier(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidLookupIdentifier(undefined)).toBe(false);
  });

  it('rejects number', () => {
    expect(isValidLookupIdentifier(42)).toBe(false);
  });
});

describe('parseMaybeJson', () => {
  it('parses valid JSON string', () => {
    expect(parseMaybeJson('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('returns fallback for invalid JSON string', () => {
    expect(parseMaybeJson('not json', 'fallback')).toBe('fallback');
  });

  it('returns fallback for null', () => {
    expect(parseMaybeJson(null, 'default')).toBe('default');
  });

  it('returns fallback for undefined', () => {
    expect(parseMaybeJson(undefined, 'default')).toBe('default');
  });

  it('returns object as-is when already an object', () => {
    const obj = { key: 'value' };
    expect(parseMaybeJson(obj, null)).toBe(obj);
  });

  it('returns array as-is when already an array', () => {
    const arr = [1, 2, 3];
    expect(parseMaybeJson(arr, null)).toBe(arr);
  });

  it('returns number as-is', () => {
    expect(parseMaybeJson(42, null)).toBe(42);
  });

  it('parses JSON array string', () => {
    expect(parseMaybeJson('[1,2]', [])).toEqual([1, 2]);
  });
});

describe('getEventTagValue', () => {
  it('returns value for existing tag', () => {
    const tags = [['e', 'event-id'], ['p', 'pubkey-value']];
    expect(getEventTagValue(tags, 'p')).toBe('pubkey-value');
  });

  it('returns null for missing tag', () => {
    const tags = [['e', 'event-id']];
    expect(getEventTagValue(tags, 'x')).toBe(null);
  });

  it('returns null for null tags', () => {
    expect(getEventTagValue(null, 'e')).toBe(null);
  });

  it('returns null for undefined tags', () => {
    expect(getEventTagValue(undefined, 'e')).toBe(null);
  });

  it('returns null for empty tags array', () => {
    expect(getEventTagValue([], 'e')).toBe(null);
  });

  it('returns first matching tag value', () => {
    const tags = [['x', 'first'], ['x', 'second']];
    expect(getEventTagValue(tags, 'x')).toBe('first');
  });
});

describe('parseImetaParams', () => {
  it('parses multiple imeta params', () => {
    const tags = [['imeta', 'url https://example.com/file.mp4', 'x ' + VALID_SHA, 'm video/mp4']];
    const result = parseImetaParams(tags);
    expect(result).toEqual({
      url: 'https://example.com/file.mp4',
      x: VALID_SHA,
      m: 'video/mp4',
    });
  });

  it('returns empty object when no imeta tag', () => {
    const tags = [['e', 'event-id']];
    expect(parseImetaParams(tags)).toEqual({});
  });

  it('returns empty object for null tags', () => {
    expect(parseImetaParams(null)).toEqual({});
  });

  it('returns empty object for undefined tags', () => {
    expect(parseImetaParams(undefined)).toEqual({});
  });

  it('skips entries without separator', () => {
    const tags = [['imeta', 'noseparator', 'url https://example.com']];
    const result = parseImetaParams(tags);
    expect(result).toEqual({ url: 'https://example.com' });
  });

  it('skips null entries within imeta tag', () => {
    const tags = [['imeta', null, 'url https://example.com']];
    const result = parseImetaParams(tags);
    expect(result).toEqual({ url: 'https://example.com' });
  });

  it('skips non-string entries within imeta tag', () => {
    const tags = [['imeta', 123, 'url https://example.com']];
    const result = parseImetaParams(tags);
    expect(result).toEqual({ url: 'https://example.com' });
  });

  it('handles empty tags array', () => {
    expect(parseImetaParams([])).toEqual({});
  });
});

describe('extractShaFromUrl', () => {
  it('extracts sha from CDN URL', () => {
    const url = `https://cdn.example.com/${VALID_SHA}`;
    expect(extractShaFromUrl(url)).toBe(VALID_SHA);
  });

  it('extracts sha from URL with extension', () => {
    const url = `https://cdn.example.com/${VALID_SHA}.mp4`;
    expect(extractShaFromUrl(url)).toBe(VALID_SHA);
  });

  it('lowercases uppercase SHA in URL', () => {
    const url = `https://cdn.example.com/${VALID_SHA_UPPER}`;
    expect(extractShaFromUrl(url)).toBe(VALID_SHA_UPPER.toLowerCase());
  });

  it('returns null when no hash in URL', () => {
    expect(extractShaFromUrl('https://example.com/file.mp4')).toBe(null);
  });

  it('returns null for non-string input', () => {
    expect(extractShaFromUrl(null)).toBe(null);
    expect(extractShaFromUrl(undefined)).toBe(null);
    expect(extractShaFromUrl(123)).toBe(null);
  });
});

describe('extractMediaShaFromEvent', () => {
  it('extracts SHA from imeta x param', () => {
    const event = {
      tags: [['imeta', `x ${VALID_SHA}`, 'url https://example.com/file.mp4']],
    };
    expect(extractMediaShaFromEvent(event)).toBe(VALID_SHA);
  });

  it('extracts SHA from x tag when no imeta x', () => {
    const event = {
      tags: [['x', VALID_SHA]],
    };
    expect(extractMediaShaFromEvent(event)).toBe(VALID_SHA);
  });

  it('extracts SHA from imeta url when no x available', () => {
    const event = {
      tags: [['imeta', `url https://cdn.example.com/${VALID_SHA}.mp4`]],
    };
    expect(extractMediaShaFromEvent(event)).toBe(VALID_SHA);
  });

  it('extracts SHA from url tag as last resort', () => {
    const event = {
      tags: [['url', `https://cdn.example.com/${VALID_SHA}.mp4`]],
    };
    expect(extractMediaShaFromEvent(event)).toBe(VALID_SHA);
  });

  it('returns null when no SHA found', () => {
    const event = {
      tags: [['e', 'some-event-id']],
    };
    expect(extractMediaShaFromEvent(event)).toBe(null);
  });

  it('returns null for null event', () => {
    expect(extractMediaShaFromEvent(null)).toBe(null);
  });

  it('returns null for undefined event', () => {
    expect(extractMediaShaFromEvent(undefined)).toBe(null);
  });

  it('returns null for event with no tags', () => {
    expect(extractMediaShaFromEvent({})).toBe(null);
  });

  it('prefers imeta x over x tag', () => {
    const sha1 = 'a'.repeat(64);
    const sha2 = 'b'.repeat(64);
    const event = {
      tags: [
        ['imeta', `x ${sha1}`, 'url https://example.com'],
        ['x', sha2],
      ],
    };
    expect(extractMediaShaFromEvent(event)).toBe(sha1);
  });
});
