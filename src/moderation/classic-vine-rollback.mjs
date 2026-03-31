// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Helpers for classic Vine enforcement rollback
// ABOUTME: Confirms rollback candidates and rewrites stale enforcement without re-running moderation

const ARCHIVE_SOURCES = new Set([
  'archive-export',
  'incident-backfill',
  'sha-list'
]);

export function isClassicVineRollbackCandidate({ source, nostrContext }) {
  if (!nostrContext) return false;

  if (nostrContext.platform === 'vine') return true;
  if (nostrContext.sourceUrl?.includes('vine.co')) return true;
  if (nostrContext.vineHashId) return true;
  if (nostrContext.client && /vine-(archive-importer|archaeologist)/.test(nostrContext.client)) return true;

  return ARCHIVE_SOURCES.has(source) && Number(nostrContext.publishedAt) < 1514764800;
}

export function buildClassicVineRollbackUpdate(row, reviewedAt) {
  return {
    ...row,
    action: 'SAFE',
    review_notes: 'incident rollback: classic vine restore',
    reviewed_by: 'classic-vine-rollback',
    reviewed_at: reviewedAt
  };
}

export function getClassicVineRollbackKvKeys(sha256) {
  return [
    `review:${sha256}`,
    `quarantine:${sha256}`,
    `age-restricted:${sha256}`,
    `permanent-ban:${sha256}`
  ];
}
