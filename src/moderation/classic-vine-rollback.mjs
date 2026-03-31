// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Helpers for classic Vine enforcement rollback
// ABOUTME: Confirms rollback candidates and rewrites stale enforcement without re-running moderation

import { fetchNostrEventBySha256, parseVideoEventMetadata } from '../nostr/relay-client.mjs';

const ARCHIVE_SOURCES = new Set([
  'archive-export',
  'incident-backfill',
  'sha-list'
]);
const VALID_MODES = new Set(['execute', 'preview', 'resume']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeRollbackItem(item) {
  if (typeof item === 'string') {
    return {
      sha256: item.toLowerCase(),
      nostrContext: null
    };
  }

  if (!item || typeof item !== 'object') {
    return {
      sha256: null,
      nostrContext: null
    };
  }

  return {
    sha256: typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : null,
    nostrContext: item.nostrContext || null
  };
}

function normalizeClassicVineRollbackRequest(body = {}) {
  const mode = typeof body.mode === 'string' ? body.mode : 'preview';
  if (!VALID_MODES.has(mode)) {
    throw createHttpError(400, 'mode must be one of: preview, execute, resume');
  }

  const rawItems = Array.isArray(body.videos)
    ? body.videos
    : Array.isArray(body.sha256s)
      ? body.sha256s
      : [];

  if (rawItems.length === 0) {
    throw createHttpError(400, 'sha256s or videos array required');
  }

  const limitValue = Number.parseInt(String(body.limit ?? DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(limitValue)
    ? Math.min(Math.max(limitValue, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const cursorValue = Number.parseInt(String(body.cursor ?? 0), 10);
  const cursor = Number.isFinite(cursorValue) && cursorValue > 0 ? cursorValue : 0;

  return {
    mode,
    source: typeof body.source === 'string' && body.source.length > 0 ? body.source : 'sha-list',
    items: rawItems.map(normalizeRollbackItem),
    limit,
    cursor
  };
}

function sliceClassicVineRollbackItems(items, cursor, limit) {
  const start = Math.min(cursor, items.length);
  const end = Math.min(start + limit, items.length);
  return {
    batch: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null
  };
}

function createRollbackCandidateResult(sha256, reason, extras = {}) {
  return {
    sha256,
    reason,
    ...extras
  };
}

async function resolveRollbackNostrContext(item, env) {
  if (item.nostrContext) {
    return item.nostrContext;
  }

  const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
  const event = await fetchNostrEventBySha256(item.sha256, relays, env);
  return event ? parseVideoEventMetadata(event) : null;
}

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

async function getClassicVineRollbackStaleKvKeys(sha256, env) {
  const keys = getClassicVineRollbackKvKeys(sha256);
  const values = await Promise.all(keys.map((key) => env.MODERATION_KV.get(key)));
  return keys.filter((_, index) => values[index] !== null);
}

export async function executeClassicVineRollback(item, env, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : new Date().toISOString();
  const notifyBlossom = deps.notifyBlossom || (async () => ({ success: true, skipped: true }));

  const existingRow = await env.BLOSSOM_DB.prepare(
    'SELECT sha256, action, provider, scores, categories, moderated_at, uploaded_by FROM moderation_results WHERE sha256 = ?'
  ).bind(item.sha256).first();
  const staleKvKeys = await getClassicVineRollbackStaleKvKeys(item.sha256, env);
  const alreadySafe = existingRow?.action === 'SAFE';

  if (!alreadySafe) {
    const update = buildClassicVineRollbackUpdate(existingRow || {
      sha256: item.sha256,
      action: 'SAFE',
      provider: 'classic-vine-rollback',
      scores: JSON.stringify({}),
      categories: JSON.stringify([]),
      moderated_at: now,
      uploaded_by: null
    }, now);

    await env.BLOSSOM_DB.prepare(`
      INSERT INTO moderation_results (
        sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, review_notes, uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        action = excluded.action,
        provider = excluded.provider,
        scores = excluded.scores,
        categories = excluded.categories,
        reviewed_by = excluded.reviewed_by,
        reviewed_at = excluded.reviewed_at,
        review_notes = excluded.review_notes,
        uploaded_by = COALESCE(moderation_results.uploaded_by, excluded.uploaded_by)
    `).bind(
      item.sha256,
      update.action,
      update.provider || 'classic-vine-rollback',
      update.scores || JSON.stringify({}),
      update.categories || JSON.stringify([]),
      update.moderated_at || now,
      update.reviewed_by,
      update.reviewed_at,
      update.review_notes,
      update.uploaded_by || null
    ).run();
  }

  if (staleKvKeys.length > 0) {
    await Promise.all(staleKvKeys.map((key) => env.MODERATION_KV.delete(key)));
  }

  const shouldNotifyBlossom = !alreadySafe || staleKvKeys.length > 0;
  const blossomResult = shouldNotifyBlossom
    ? await notifyBlossom(item.sha256, 'SAFE')
    : { success: true, skipped: true };

  return {
    sha256: item.sha256,
    previousAction: existingRow?.action || null,
    alreadySafe,
    staleKvKeysCleared: staleKvKeys,
    blossomNotified: blossomResult.success || blossomResult.skipped || false,
    blossomError: blossomResult.success || blossomResult.skipped ? null : blossomResult.error || 'Unknown Blossom notification failure'
  };
}

export async function runClassicVineRollback(body, env, deps = {}) {
  const startedAt = typeof deps.now === 'function' ? deps.now() : new Date().toISOString();
  const request = normalizeClassicVineRollbackRequest(body);
  const { batch, nextCursor } = sliceClassicVineRollbackItems(request.items, request.cursor, request.limit);
  const candidates = [];
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of batch) {
    if (!item.sha256 || !SHA256_PATTERN.test(item.sha256)) {
      failed += 1;
      candidates.push(createRollbackCandidateResult(item.sha256, 'invalid-sha256', {
        would_restore: false,
        restored: false
      }));
      continue;
    }

    try {
      const nostrContext = await resolveRollbackNostrContext(item, env);
      const matched = isClassicVineRollbackCandidate({
        source: request.source,
        nostrContext
      });

      if (!matched) {
        skipped += 1;
        candidates.push(createRollbackCandidateResult(item.sha256, nostrContext ? 'not-classic-vine' : 'missing-vine-metadata', {
          would_restore: false,
          restored: false
        }));
        continue;
      }

      if (request.mode === 'preview') {
        candidates.push(createRollbackCandidateResult(item.sha256, 'confirmed-classic-vine', {
          would_restore: true
        }));
        continue;
      }

      const rollbackResult = await executeClassicVineRollback(item, env, deps);

      if (!rollbackResult.blossomNotified) {
        failed += 1;
        candidates.push(createRollbackCandidateResult(item.sha256, 'blossom-notification-failed', {
          restored: false,
          previous_action: rollbackResult.previousAction,
          already_safe: rollbackResult.alreadySafe,
          blossom_notified: false,
          stale_kv_keys_cleared: rollbackResult.staleKvKeysCleared,
          error: rollbackResult.blossomError
        }));
        continue;
      }

      if (rollbackResult.alreadySafe) {
        skipped += 1;
        candidates.push(createRollbackCandidateResult(item.sha256, 'already-safe', {
          restored: false,
          previous_action: rollbackResult.previousAction,
          already_safe: true,
          blossom_notified: true,
          stale_kv_keys_cleared: rollbackResult.staleKvKeysCleared
        }));
        continue;
      }

      restored += 1;
      candidates.push(createRollbackCandidateResult(item.sha256, 'confirmed-classic-vine', {
        restored: true,
        previous_action: rollbackResult.previousAction,
        blossom_notified: true
      }));
    } catch (error) {
      failed += 1;
      candidates.push(createRollbackCandidateResult(item.sha256, 'rollback-failed', {
        would_restore: false,
        restored: false,
        error: error.message
      }));
    }
  }

  return {
    mode: request.mode,
    source: request.source,
    processed: batch.length,
    restored,
    skipped,
    failed,
    next_cursor: nextCursor,
    started_at: startedAt,
    finished_at: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
    candidates
  };
}
