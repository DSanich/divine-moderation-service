// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for canonical moderation vocabulary module
// ABOUTME: Verifies label normalization, alias resolution, and classifier category mapping

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_LABELS,
  ALIASES,
  normalizeLabel,
  isCanonicalLabel,
  classifierCategoryToLabels,
} from './vocabulary.mjs';

describe('CANONICAL_LABELS', () => {
  it('should contain exactly 19 labels', () => {
    expect(CANONICAL_LABELS).toHaveLength(19);
  });

  it('should include key moderation labels', () => {
    expect(CANONICAL_LABELS).toContain('nudity');
    expect(CANONICAL_LABELS).toContain('porn');
    expect(CANONICAL_LABELS).toContain('graphic-media');
    expect(CANONICAL_LABELS).toContain('violence');
    expect(CANONICAL_LABELS).toContain('self-harm');
    expect(CANONICAL_LABELS).toContain('drugs');
    expect(CANONICAL_LABELS).toContain('hate');
    expect(CANONICAL_LABELS).toContain('spam');
    expect(CANONICAL_LABELS).toContain('ai-generated');
    expect(CANONICAL_LABELS).toContain('deepfake');
  });

  it('should all be lowercase kebab-case strings', () => {
    for (const label of CANONICAL_LABELS) {
      expect(label).toBe(label.toLowerCase());
      expect(label).not.toMatch(/_/);
    }
  });
});

describe('normalizeLabel', () => {
  it('should resolve aliases to canonical labels', () => {
    expect(normalizeLabel('pornography')).toBe('porn');
    expect(normalizeLabel('explicit')).toBe('porn');
    expect(normalizeLabel('gore')).toBe('graphic-media');
    expect(normalizeLabel('graphic-violence')).toBe('graphic-media');
    expect(normalizeLabel('nsfw')).toBe('nudity');
    expect(normalizeLabel('offensive')).toBe('hate');
    expect(normalizeLabel('hate-speech')).toBe('hate');
    expect(normalizeLabel('weapon')).toBe('violence');
    expect(normalizeLabel('recreational_drug')).toBe('drugs');
  });

  it('should convert snake_case to kebab-case', () => {
    expect(normalizeLabel('hate_speech')).toBe('hate');
    expect(normalizeLabel('self_harm')).toBe('self-harm');
    expect(normalizeLabel('ai_generated')).toBe('ai-generated');
  });

  it('should lowercase input', () => {
    expect(normalizeLabel('NUDITY')).toBe('nudity');
    expect(normalizeLabel('Violence')).toBe('violence');
    expect(normalizeLabel('PORN')).toBe('porn');
  });

  it('should pass through already-canonical labels unchanged', () => {
    expect(normalizeLabel('nudity')).toBe('nudity');
    expect(normalizeLabel('porn')).toBe('porn');
    expect(normalizeLabel('violence')).toBe('violence');
    expect(normalizeLabel('self-harm')).toBe('self-harm');
  });

  it('should pass through unknown labels in kebab-case', () => {
    expect(normalizeLabel('unknown_label')).toBe('unknown-label');
    expect(normalizeLabel('custom')).toBe('custom');
  });
});

describe('isCanonicalLabel', () => {
  it('should return true for canonical labels', () => {
    expect(isCanonicalLabel('nudity')).toBe(true);
    expect(isCanonicalLabel('porn')).toBe(true);
    expect(isCanonicalLabel('self-harm')).toBe(true);
    expect(isCanonicalLabel('ai-generated')).toBe(true);
  });

  it('should return true for aliases (after normalization)', () => {
    expect(isCanonicalLabel('pornography')).toBe(true);
    expect(isCanonicalLabel('gore')).toBe(true);
    expect(isCanonicalLabel('nsfw')).toBe(true);
    expect(isCanonicalLabel('weapon')).toBe(true);
  });

  it('should return true for snake_case variants', () => {
    expect(isCanonicalLabel('self_harm')).toBe(true);
    expect(isCanonicalLabel('ai_generated')).toBe(true);
    expect(isCanonicalLabel('hate_speech')).toBe(true);
  });

  it('should return false for non-canonical labels', () => {
    expect(isCanonicalLabel('unknown')).toBe(false);
    expect(isCanonicalLabel('custom-label')).toBe(false);
    expect(isCanonicalLabel('topic:sports')).toBe(false);
  });
});

describe('classifierCategoryToLabels', () => {
  it('should map nudity to nudity', () => {
    expect(classifierCategoryToLabels('nudity')).toEqual(['nudity']);
  });

  it('should map sexual to sexual', () => {
    expect(classifierCategoryToLabels('sexual')).toEqual(['sexual']);
  });

  it('should map porn to porn', () => {
    expect(classifierCategoryToLabels('porn')).toEqual(['porn']);
  });

  it('should map gore to graphic-media', () => {
    expect(classifierCategoryToLabels('gore')).toEqual(['graphic-media']);
  });

  it('should map weapon to violence', () => {
    expect(classifierCategoryToLabels('weapon')).toEqual(['violence']);
  });

  it('should map offensive to hate', () => {
    expect(classifierCategoryToLabels('offensive')).toEqual(['hate']);
  });

  it('should map self_harm to self-harm', () => {
    expect(classifierCategoryToLabels('self_harm')).toEqual(['self-harm']);
  });

  it('should map ai_generated to ai-generated', () => {
    expect(classifierCategoryToLabels('ai_generated')).toEqual(['ai-generated']);
  });

  it('should map substance categories', () => {
    expect(classifierCategoryToLabels('recreational_drug')).toEqual(['drugs']);
    expect(classifierCategoryToLabels('alcohol')).toEqual(['alcohol']);
    expect(classifierCategoryToLabels('tobacco')).toEqual(['tobacco']);
    expect(classifierCategoryToLabels('gambling')).toEqual(['gambling']);
  });

  it('should return empty array for unknown categories', () => {
    expect(classifierCategoryToLabels('unknown')).toEqual([]);
    expect(classifierCategoryToLabels('topic:sports')).toEqual([]);
  });
});
