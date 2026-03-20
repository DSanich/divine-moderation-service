// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// ABOUTME: Maps inbound ATProto labels to Nostr NIP-32 / NIP-09 publish actions
// ABOUTME: Used when ATProto labels are approved for cross-network propagation

/**
 * ATProto label → DiVine/Nostr category mapping.
 * MUST stay in sync with divine-moderation-adapter/src/labels/vocabulary.rs
 */
const ATPROTO_TO_NOSTR = {
  'porn':          { category: 'nudity',       namespace: 'content-warning' },
  'sexual':        { category: 'nudity',       namespace: 'content-warning' },
  'nudity':        { category: 'nudity',       namespace: 'content-warning' },
  'gore':          { category: 'violence',     namespace: 'content-warning' },
  'graphic-media': { category: 'violence',     namespace: 'content-warning' },
  'violence':      { category: 'violence',     namespace: 'content-warning' },
  'self-harm':     { category: 'self_harm',    namespace: 'content-warning' },
  'spam':          { category: 'offensive',    namespace: 'content-warning' },
  'ai-generated':  { category: 'ai_generated', namespace: 'content-warning' },
  'deepfake':      { category: 'deepfake',     namespace: 'content-warning' },
};

/**
 * Build Nostr publish parameters from an inbound ATProto label.
 *
 * @param {Object} opts
 * @param {string} opts.val - ATProto label value
 * @param {boolean} opts.neg - Is negation
 * @param {string} opts.sha256 - Content hash
 * @param {string} [opts.nostrEventId] - Mapped Nostr event ID
 * @returns {Object|null} Publish params or null if unmapped
 */
export function buildNostrLabelFromAtproto({ val, neg, sha256, nostrEventId }) {
  // System labels → special actions
  if (val === '!takedown' && !neg) {
    return {
      action: 'delete',
      category: null,
      sha256,
      nostrEventId: nostrEventId || null,
    };
  }

  if (val === '!suspend' && !neg) {
    return {
      action: 'ban',
      category: null,
      sha256,
      nostrEventId: nostrEventId || null,
    };
  }

  // Content labels → NIP-32 label events
  const mapping = ATPROTO_TO_NOSTR[val];
  if (!mapping) return null;

  return {
    action: 'label',
    category: mapping.category,
    namespace: mapping.namespace,
    status: neg ? 'rejected' : 'confirmed',
    score: 1.0,
    sha256,
    nostrEventId: nostrEventId || null,
  };
}
