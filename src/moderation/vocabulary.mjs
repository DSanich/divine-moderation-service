// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Canonical moderation vocabulary module
// ABOUTME: Single source of truth for moderation label vocabulary and normalization

export const CANONICAL_LABELS = [
  'nudity', 'sexual', 'porn', 'graphic-media', 'violence',
  'self-harm', 'drugs', 'alcohol', 'tobacco', 'gambling',
  'profanity', 'hate', 'harassment', 'flashing-lights',
  'ai-generated', 'deepfake', 'misleading', 'spam', 'scam',
];

export const ALIASES = {
  pornography: 'porn',
  explicit: 'porn',
  'graphic-violence': 'graphic-media',
  gore: 'graphic-media',
  nsfw: 'nudity',
  offensive: 'hate',
  'hate-speech': 'hate',
  hate_speech: 'hate',
  self_harm: 'self-harm',
  ai_generated: 'ai-generated',
  recreational_drug: 'drugs',
  weapon: 'violence',
};

/**
 * Normalize a label to its canonical form.
 * Lowercases, converts snake_case to kebab-case, and resolves aliases.
 * @param {string} label - The label to normalize
 * @returns {string} The canonical label
 */
export function normalizeLabel(label) {
  const lower = label.toLowerCase().replace(/_/g, '-');
  return ALIASES[lower] || ALIASES[label] || lower;
}

/**
 * Check if a label is (or normalizes to) a canonical moderation label.
 * @param {string} label - The label to check
 * @returns {boolean}
 */
export function isCanonicalLabel(label) {
  return CANONICAL_LABELS.includes(normalizeLabel(label));
}

/**
 * Map a classifier category to canonical moderation labels.
 * @param {string} category - The classifier category (e.g. 'nudity', 'gore', 'weapon')
 * @param {number} [scores] - Optional score value (unused, reserved for future threshold logic)
 * @returns {string[]} Array of canonical moderation labels
 */
export function classifierCategoryToLabels(category, scores) {
  const map = {
    nudity: ['nudity'],
    violence: ['violence'],
    gore: ['graphic-media'],
    offensive: ['hate'],
    self_harm: ['self-harm'],
    ai_generated: ['ai-generated'],
    deepfake: ['deepfake'],
    weapon: ['violence'],
    recreational_drug: ['drugs'],
    alcohol: ['alcohol'],
    tobacco: ['tobacco'],
    gambling: ['gambling'],
  };
  const labels = [];
  if (map[category]) {
    labels.push(...map[category]);
  }
  return labels;
}
