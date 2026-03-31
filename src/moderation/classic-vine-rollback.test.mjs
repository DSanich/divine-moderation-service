// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for classic Vine enforcement rollback helpers
// ABOUTME: Verifies rollback candidate matching and enforcement rewrite semantics

import { describe, expect, it } from 'vitest';
import {
  buildClassicVineRollbackUpdate,
  getClassicVineRollbackKvKeys,
  isClassicVineRollbackCandidate
} from './classic-vine-rollback.mjs';

describe('isClassicVineRollbackCandidate', () => {
  it('accepts explicit Vine platform metadata', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'sha-list',
      nostrContext: { platform: 'vine' }
    })).toBe(true);
  });

  it('accepts vine.co source URLs', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'sha-list',
      nostrContext: { sourceUrl: 'https://vine.co/v/abc123' }
    })).toBe(true);
  });

  it('accepts published_at fallback only for archive-oriented sources', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'archive-export',
      nostrContext: { publishedAt: 1389756506 }
    })).toBe(true);
  });

  it('rejects weak timestamp-only matches for generic sources', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'd1-query',
      nostrContext: { publishedAt: 1389756506 }
    })).toBe(false);
  });
});

describe('buildClassicVineRollbackUpdate', () => {
  it('preserves stored scores and categories while forcing SAFE enforcement', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'PERMANENT_BAN',
      provider: 'hive',
      scores: JSON.stringify({ ai_generated: 0.97 }),
      categories: JSON.stringify(['ai_generated']),
      moderated_at: '2026-03-01T00:00:00.000Z'
    };

    const result = buildClassicVineRollbackUpdate(row, '2026-03-31T00:00:00.000Z');

    expect(result.action).toBe('SAFE');
    expect(result.scores).toBe(row.scores);
    expect(result.categories).toBe(row.categories);
    expect(result.reviewed_by).toBe('classic-vine-rollback');
  });
});

describe('getClassicVineRollbackKvKeys', () => {
  it('returns the full KV key list to clear on every execute pass', () => {
    expect(getClassicVineRollbackKvKeys('a'.repeat(64))).toEqual([
      `review:${'a'.repeat(64)}`,
      `quarantine:${'a'.repeat(64)}`,
      `age-restricted:${'a'.repeat(64)}`,
      `permanent-ban:${'a'.repeat(64)}`
    ]);
  });
});
