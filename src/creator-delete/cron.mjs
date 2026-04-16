// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cron work for creator-delete pipeline — pulls kind 5 from Funnelcake, retries transient failures.
// ABOUTME: Runs every minute via wrangler.toml [triggers] crons entry; dispatched in scheduled(event, env, ctx).

import { processKind5 } from './process.mjs';

const LAST_POLL_KEY = 'creator-delete-cron:last-poll';
const DEFAULT_LOOKBACK_SECONDS = 3600; // first run
const MAX_RETRY_COUNT = 5;

export async function runCreatorDeleteCron(deps) {
  const { db, kv, queryKind5Since, fetchTargetEvent, callBlossomDelete, now = () => Date.now() } = deps;
  const nowMs = now();

  const lastPollRaw = await kv.get(LAST_POLL_KEY);
  const lastPollMs = lastPollRaw ? Number(lastPollRaw) : nowMs - (DEFAULT_LOOKBACK_SECONDS * 1000);
  const sinceSeconds = Math.floor(lastPollMs / 1000);

  let processed = 0;
  const errors = [];

  try {
    const events = await queryKind5Since(sinceSeconds);
    for (const kind5 of events) {
      try {
        const lagSeconds = Math.max(0, Math.floor(now() / 1000) - (kind5.created_at || 0));
        console.log(JSON.stringify({
          event: 'creator_delete.cron.kind5_lag',
          kind5_id: kind5.id,
          lag_seconds: lagSeconds
        }));
        await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, triggerLabel: 'cron' });
        processed++;
      } catch (e) {
        errors.push({ kind5_id: kind5.id, error: e.message });
      }
    }
  } catch (e) {
    errors.push({ stage: 'query', error: e.message });
  }

  // Retry failed:transient rows
  const transientRows = await db.prepare(
    `SELECT kind5_id, target_event_id, creator_pubkey, status, retry_count, accepted_at
     FROM creator_deletions
     WHERE status LIKE 'failed:transient:%' AND retry_count < ?`
  ).bind(MAX_RETRY_COUNT).all();

  for (const row of (transientRows.results || [])) {
    try {
      const kind5 = { id: row.kind5_id, pubkey: row.creator_pubkey, tags: [['e', row.target_event_id]] };
      await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, triggerLabel: 'cron' });
      processed++;
    } catch (e) {
      errors.push({ kind5_id: row.kind5_id, stage: 'retry', error: e.message });
    }
  }

  await kv.put(LAST_POLL_KEY, String(nowMs));

  return { processed, errors };
}

export { LAST_POLL_KEY };
