// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the shared uploader-identity helpers used by the
// ABOUTME: admin dashboard and Quick Review to render Nostr event meta.

import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  buildDivineVideoUrl,
  buildProfileUrl,
  truncatePubkey,
  pickAuthorName,
  createEventMetaHTML,
} from './event-meta.mjs';

const PUBKEY = 'a'.repeat(64);
const EVENT_ID = '1'.repeat(64);

describe('escapeHtml', () => {
  it('escapes angle brackets, ampersands and quotes', () => {
    expect(escapeHtml('<a href="x">&"\'</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&quot;&#39;&lt;/a&gt;'
    );
  });

  it('coerces null/undefined to empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('buildDivineVideoUrl', () => {
  it('prefers an explicit divineUrl', () => {
    expect(
      buildDivineVideoUrl({
        divineUrl: 'https://divine.video/video/stable-id',
        eventId: EVENT_ID,
      })
    ).toBe('https://divine.video/video/stable-id');
  });

  it('falls back to eventId', () => {
    expect(buildDivineVideoUrl({ eventId: EVENT_ID })).toBe(
      `https://divine.video/video/${EVENT_ID}`
    );
  });

  it('returns null when no identifier is present', () => {
    expect(buildDivineVideoUrl({})).toBeNull();
  });
});

describe('buildProfileUrl', () => {
  it('returns a profile url for a pubkey', () => {
    expect(buildProfileUrl(PUBKEY)).toBe(`https://divine.video/profile/${PUBKEY}`);
  });

  it('returns null when pubkey missing', () => {
    expect(buildProfileUrl(null)).toBeNull();
    expect(buildProfileUrl('')).toBeNull();
  });
});

describe('truncatePubkey', () => {
  it('shortens a 64-char hex pubkey', () => {
    const result = truncatePubkey(PUBKEY);
    expect(result.length).toBeLessThan(PUBKEY.length);
    expect(result).toMatch(/\.\.\./);
    expect(result.startsWith('aaaaaaaa')).toBe(true);
    expect(result.endsWith('aaaaaaaa')).toBe(true);
  });

  it('returns short strings unchanged', () => {
    expect(truncatePubkey('abc')).toBe('abc');
  });

  it('handles nullish values', () => {
    expect(truncatePubkey(null)).toBe('');
    expect(truncatePubkey(undefined)).toBe('');
  });
});

describe('pickAuthorName', () => {
  it('returns the top-level author first', () => {
    expect(pickAuthorName({ author: 'Top', nostrContext: { author: 'Nested' } })).toBe('Top');
  });

  it('falls back to nostrContext.author', () => {
    expect(pickAuthorName({ nostrContext: { author: 'Nested' } })).toBe('Nested');
  });

  it('returns "Unknown publisher" when no name is available', () => {
    expect(pickAuthorName({})).toBe('Unknown publisher');
  });
});

describe('createEventMetaHTML', () => {
  it('renders author name, truncated pubkey, and outbound links', () => {
    const html = createEventMetaHTML({
      author: 'Alice',
      uploaded_by: PUBKEY,
      eventId: EVENT_ID,
      divineUrl: `https://divine.video/video/${EVENT_ID}`,
      nostrContext: { publishedAt: 1_700_000_000 },
    });

    expect(html).toContain('Alice');
    expect(html).toContain('aaaaaaaa');
    expect(html).toContain(`https://divine.video/profile/${PUBKEY}`);
    expect(html).toContain(`https://divine.video/video/${EVENT_ID}`);
    expect(html).toMatch(/event-meta/);
  });

  it('escapes hostile author names', () => {
    const html = createEventMetaHTML({ author: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a fallback when identity is missing', () => {
    const html = createEventMetaHTML({});
    expect(html).toContain('Unknown publisher');
    // Should NOT render a broken profile link
    expect(html).not.toContain('divine.video/profile/null');
    expect(html).not.toContain('divine.video/profile/undefined');
  });

  it('includes a profile link when only nostrContext.pubkey is present', () => {
    const html = createEventMetaHTML({
      nostrContext: { pubkey: PUBKEY, author: 'Bob' },
    });
    expect(html).toContain(`https://divine.video/profile/${PUBKEY}`);
    expect(html).toContain('Bob');
  });
});
