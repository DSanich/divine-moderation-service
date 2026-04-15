// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import { buildProvenance } from './provenance.mjs';

describe('buildProvenance', () => {
  it('classifies strong Vine evidence as original_vine', () => {
    const result = buildProvenance({
      nostrContext: {
        platform: 'vine',
        sourceUrl: 'https://vine.co/v/abc',
        publishedAt: 1408579200,
      },
      receivedAt: '2026-04-14T00:00:00.000Z',
    });

    expect(result.status).toBe('original_vine');
    expect(result.label).toBe('Original Vine');
    expect(result.isOriginalVine).toBe(true);
    expect(result.isPre2022).toBe(true);
    expect(result.dateSource).toBe('published_at');
    expect(result.reasons).toContain('platform:vine');
  });

  it('classifies published_at before 2022 as pre_2022_legacy', () => {
    const result = buildProvenance({
      nostrContext: { publishedAt: 1637193600 },
      receivedAt: '2026-04-14T00:00:00.000Z',
    });

    expect(result.status).toBe('pre_2022_legacy');
    expect(result.label).toBe('Pre-2022 Legacy');
    expect(result.isPre2022).toBe(true);
    expect(result.isOriginalVine).toBe(false);
    expect(result.dateSource).toBe('published_at');
  });

  it('falls back to nostr_created_at when published_at is unavailable', () => {
    const result = buildProvenance({
      nostrContext: { createdAt: 1609459200 },
      receivedAt: '2026-04-14T00:00:00.000Z',
    });

    expect(result.status).toBe('pre_2022_legacy');
    expect(result.dateSource).toBe('nostr_created_at');
    expect(result.reasons).toContain('nostr_created_at:2021-01-01T00:00:00.000Z');
  });

  it('does not treat receivedAt alone as legacy', () => {
    const result = buildProvenance({
      nostrContext: null,
      receivedAt: '2020-01-01T00:00:00.000Z',
    });

    expect(result.status).toBe('unknown_or_modern');
    expect(result.label).toBe('Unknown Provenance');
    expect(result.isPre2022).toBe(false);
    expect(result.dateSource).toBe('none');
  });
});
