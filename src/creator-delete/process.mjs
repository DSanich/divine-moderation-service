// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared kind 5 processing function used by both sync endpoint and cron.
// ABOUTME: Race-safe via D1 INSERT-OR-IGNORE claim, handles multi-target kind 5 per NIP-09.

import { claimRow, updateToSuccess, updateToFailed, decideAction } from './d1.mjs';

/**
 * Extract the main blob sha256 from a kind 34236 video event.
 * Looks at imeta tags for x=<sha256> or parses url for the sha256 segment.
 */
export function extractSha256(targetEvent) {
  for (const tag of targetEvent.tags || []) {
    if (tag[0] !== 'imeta') continue;
    for (const part of tag.slice(1)) {
      if (typeof part !== 'string') continue;
      const xMatch = part.match(/^x\s+([a-f0-9]{64})$/i);
      if (xMatch) return xMatch[1].toLowerCase();
      const urlMatch = part.match(/^url\s+\S*\/([a-f0-9]{64})(?:\.\w+)?(?:\?|$)/i);
      if (urlMatch) return urlMatch[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Process a kind 5 event. Processes each e-tag target independently.
 * Returns { targets: [{ target_event_id, status, blob_sha256?, last_error? }] }
 */
export async function processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now = () => Date.now(), triggerLabel = 'unknown' }) {
  const targetIds = (kind5.tags || [])
    .filter(t => t[0] === 'e' && t[1])
    .map(t => t[1]);

  const resultTargets = [];

  for (const target_event_id of targetIds) {
    const acceptedIso = new Date(now()).toISOString();
    const claim = await claimRow(db, {
      kind5_id: kind5.id,
      target_event_id,
      creator_pubkey: kind5.pubkey,
      accepted_at: acceptedIso
    });

    const action = claim.claimed ? 'proceed' : decideAction(claim.existing, { now: now() });

    if (action === 'skip_success') {
      resultTargets.push({ target_event_id, status: 'success', blob_sha256: claim.existing.blob_sha256 });
      continue;
    }
    if (action === 'skip_permanent_failure') {
      resultTargets.push({ target_event_id, status: claim.existing.status, last_error: claim.existing.last_error });
      continue;
    }
    if (action === 'skip_in_progress') {
      resultTargets.push({ target_event_id, status: 'in_progress' });
      continue;
    }

    // action === 'proceed' — re-claim stale row by refreshing accepted_at
    if (!claim.claimed) {
      await db.prepare(
        `UPDATE creator_deletions SET accepted_at = ?, status = 'accepted' WHERE kind5_id = ? AND target_event_id = ?`
      ).bind(acceptedIso, kind5.id, target_event_id).run();
    }
    console.log(JSON.stringify({
      event: 'creator_delete.accepted',
      kind5_id: kind5.id,
      target_event_id,
      creator_pubkey: kind5.pubkey,
      accepted_at: acceptedIso,
      trigger: triggerLabel
    }));

    const target = await fetchTargetEvent(target_event_id);
    if (!target) {
      await updateToFailed(db, {
        kind5_id: kind5.id,
        target_event_id,
        status: 'failed:permanent:target_unresolved',
        last_error: 'Target event not found on Funnelcake'
      });
      console.log(JSON.stringify({
        event: 'creator_delete.failed',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        status: 'failed:permanent:target_unresolved',
        last_error: 'Target event not found on Funnelcake',
        retry_count_after: (claim.existing && claim.existing.retry_count) || 0,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'failed:permanent:target_unresolved' });
      continue;
    }

    const sha256 = extractSha256(target);
    if (!sha256) {
      await updateToFailed(db, {
        kind5_id: kind5.id,
        target_event_id,
        status: 'failed:permanent:no_sha256',
        last_error: 'No sha256 in target event imeta/url'
      });
      console.log(JSON.stringify({
        event: 'creator_delete.failed',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        status: 'failed:permanent:no_sha256',
        last_error: 'No sha256 in target event imeta/url',
        retry_count_after: (claim.existing && claim.existing.retry_count) || 0,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'failed:permanent:no_sha256' });
      continue;
    }

    const blossomResult = await callBlossomDelete(sha256);
    if (blossomResult.success && !blossomResult.skipped) {
      const completedIso = new Date(now()).toISOString();
      await updateToSuccess(db, {
        kind5_id: kind5.id,
        target_event_id,
        blob_sha256: sha256,
        completed_at: completedIso
      });
      console.log(JSON.stringify({
        event: 'creator_delete.success',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        blob_sha256: sha256,
        completed_at: completedIso,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'success', blob_sha256: sha256 });
      continue;
    }

    // Blossom failed or skipped
    const status = blossomResult.status;
    const isTransient = blossomResult.networkError || (status !== undefined && (status >= 500 || status === 429));
    const category = isTransient
      ? (blossomResult.networkError ? 'failed:transient:network' : `failed:transient:blossom_${status === 429 ? '429' : '5xx'}`)
      : (status !== undefined ? `failed:permanent:blossom_${status}` : 'failed:permanent:blossom_skipped');

    const lastError = blossomResult.error || `Blossom returned ${blossomResult.status}`;
    const priorRetryCount = (claim.existing && claim.existing.retry_count) || 0;
    const retryCountAfter = isTransient ? priorRetryCount + 1 : priorRetryCount;

    // Promote to permanent if retries exhausted
    const finalStatus = (isTransient && retryCountAfter >= 5)
      ? 'failed:permanent:max_retries_exceeded'
      : category;

    await updateToFailed(db, {
      kind5_id: kind5.id,
      target_event_id,
      status: finalStatus,
      last_error: lastError,
      increment_retry: isTransient
    });
    console.log(JSON.stringify({
      event: 'creator_delete.failed',
      kind5_id: kind5.id,
      target_event_id,
      creator_pubkey: kind5.pubkey,
      status: finalStatus,
      last_error: lastError,
      retry_count_after: retryCountAfter,
      trigger: triggerLabel
    }));
    resultTargets.push({ target_event_id, status: finalStatus, last_error: blossomResult.error, blob_sha256: sha256 });
  }

  return { targets: resultTargets };
}
