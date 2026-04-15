// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Normalizes provenance evidence for admin moderation surfaces
// ABOUTME: Ranks trusted age signals and classifies videos as legacy/Vine/unknown

import { hasStrongOriginalVineEvidence } from '../nostr/relay-client.mjs';

const PRE_2022_CUTOFF = Date.UTC(2022, 0, 1) / 1000;

function toIsoFromSeconds(value) {
  return Number.isInteger(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}

function buildReasons(nostrContext) {
  const reasons = [];

  if (nostrContext?.platform === 'vine') {
    reasons.push('platform:vine');
  }
  if (nostrContext?.sourceUrl?.includes('vine.co')) {
    reasons.push(`source_url:${nostrContext.sourceUrl}`);
  }
  if (Number.isInteger(nostrContext?.publishedAt)) {
    reasons.push(`published_at:${toIsoFromSeconds(nostrContext.publishedAt)}`);
  }
  if (Number.isInteger(nostrContext?.createdAt)) {
    reasons.push(`nostr_created_at:${toIsoFromSeconds(nostrContext.createdAt)}`);
  }

  return reasons;
}

export function buildProvenance({ nostrContext, receivedAt }) {
  const reasons = buildReasons(nostrContext);
  const publishedAt = Number.isInteger(nostrContext?.publishedAt) ? nostrContext.publishedAt : null;
  const nostrCreatedAt = Number.isInteger(nostrContext?.createdAt) ? nostrContext.createdAt : null;
  const isOriginalVine = hasStrongOriginalVineEvidence(nostrContext || {});
  let status = 'unknown_or_modern';
  let label = 'Unknown Provenance';
  let dateSource = 'none';
  let date = null;

  if (publishedAt) {
    date = toIsoFromSeconds(publishedAt);
    dateSource = 'published_at';
  } else if (nostrCreatedAt) {
    date = toIsoFromSeconds(nostrCreatedAt);
    dateSource = 'nostr_created_at';
  }

  if (isOriginalVine) {
    status = 'original_vine';
    label = 'Original Vine';
  } else if ((publishedAt && publishedAt < PRE_2022_CUTOFF) || (nostrCreatedAt && nostrCreatedAt < PRE_2022_CUTOFF)) {
    status = 'pre_2022_legacy';
    label = 'Pre-2022 Legacy';
  }

  return {
    status,
    label,
    date,
    dateSource,
    reasons,
    isPre2022: Boolean((publishedAt && publishedAt < PRE_2022_CUTOFF) || (nostrCreatedAt && nostrCreatedAt < PRE_2022_CUTOFF) || isOriginalVine),
    isOriginalVine,
    proofmode: nostrContext?.proofmode ?? null,
    receivedAt: receivedAt || null,
  };
}
