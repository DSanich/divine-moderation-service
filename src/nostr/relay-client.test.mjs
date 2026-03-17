// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import { parseVideoEventMetadata, isOriginalVine } from './relay-client.mjs';

describe('parseVideoEventMetadata', () => {
  it('extracts title from title tag', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['title', 'My Video Title']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.title).toBe('My Video Title');
  });

  it('does not extract title from subject tag (no fallback)', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['subject', 'Subject Line']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.title).toBeNull();
  });

  it('extracts author from author tag', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['author', 'Jane Doe']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.author).toBe('Jane Doe');
  });

  it('extracts client from client tag', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['client', 'vine-archaeologist']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.client).toBe('vine-archaeologist');
  });

  it('returns null for null event', () => {
    expect(parseVideoEventMetadata(null)).toBeNull();
  });

  it('returns null for event without tags', () => {
    expect(parseVideoEventMetadata({ content: 'hello' })).toBeNull();
  });

  it('returns metadata with content from event.content', () => {
    const event = {
      id: 'evt1',
      content: 'This is a video description',
      created_at: 1700000000,
      tags: [['title', 'Test']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.content).toBe('This is a video description');
  });

  it('extracts eventId and createdAt from event', () => {
    const event = {
      id: 'evt999',
      content: '',
      created_at: 1700000000,
      tags: [],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.eventId).toBe('evt999');
    expect(result.createdAt).toBe(1700000000);
  });

  it('extracts platform tag', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [['platform', 'vine']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.platform).toBe('vine');
  });

  it('parses numeric fields as integers', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [
        ['loops', '12345'],
        ['likes', '99'],
        ['comments', '7'],
      ],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.loops).toBe(12345);
    expect(result.likes).toBe(99);
    expect(result.comments).toBe(7);
  });

  it('extracts URL from imeta tag', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [['imeta', 'url https://blossom.example.com/abc123', 'm video/mp4']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.url).toBe('https://blossom.example.com/abc123');
  });
});

describe('isOriginalVine', () => {
  it('returns true for event with platform=vine', () => {
    expect(isOriginalVine({ platform: 'vine' })).toBe(true);
  });

  it('returns true for event with client=vine-archaeologist', () => {
    expect(isOriginalVine({ client: 'vine-archaeologist' })).toBe(true);
  });

  it('returns true for event with vineHashId set', () => {
    expect(isOriginalVine({ vineHashId: 'abc123' })).toBe(true);
  });

  it('returns true for event with vine.co sourceUrl', () => {
    expect(isOriginalVine({ sourceUrl: 'https://vine.co/v/abc123' })).toBe(true);
  });

  it('returns true for event published before 2018', () => {
    // Dec 31, 2017
    expect(isOriginalVine({ publishedAt: 1514678400 })).toBe(true);
  });

  it('returns false for divine-mobile client', () => {
    expect(isOriginalVine({ client: 'divine-mobile' })).toBe(false);
  });

  it('returns false for null event', () => {
    expect(isOriginalVine(null)).toBe(false);
  });

  it('returns false for empty object with no vine indicators', () => {
    expect(isOriginalVine({ client: 'some-other-client', platform: 'youtube' })).toBe(false);
  });
});
