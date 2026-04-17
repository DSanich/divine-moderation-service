// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for runCreatorDeleteCron — happy-path query and transient-retry sweep.
// ABOUTME: Uses makeFakeD1/makeFakeKV; seeds transient rows via rows.set() (fake INSERT is 4-arg only).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCreatorDeleteCron } from './cron.mjs';
import { makeFakeD1, makeFakeKV } from './test-helpers.mjs';

const SHA_C = 'c'.repeat(64); // 64-char hex fixture (extractSha256 requires)

describe('runCreatorDeleteCron', () => {
  let deps;
  beforeEach(() => {
    deps = {
      db: makeFakeD1(),
      kv: makeFakeKV(),
      queryKind5Since: vi.fn(),
      fetchTargetEvent: vi.fn(),
      callBlossomDelete: vi.fn(),
      now: () => 1700000000000
    };
  });

  it('queries Funnelcake from last poll, processes each event, updates last poll', async () => {
    await deps.kv.put('creator-delete-cron:last-poll', String(1700000000000 - 60_000));
    deps.queryKind5Since.mockResolvedValueOnce([
      { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] }
    ]);
    deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const result = await runCreatorDeleteCron(deps);
    expect(deps.queryKind5Since).toHaveBeenCalled();
    expect(result.processed).toBe(1);
    const lastPoll = await deps.kv.get('creator-delete-cron:last-poll');
    expect(Number(lastPoll)).toBe(1700000000000);
  });

  it('retries failed:transient rows with retry_count < 5', async () => {
    // Seed D1 directly — the fake's INSERT path is tailored to claimRow's
    // 4-arg bind with 'accepted' status literal, so it can't represent a
    // pre-existing failed:transient row. Direct rows.set() bypasses it.
    deps.db.rows.set('k1:t1', {
      kind5_id: 'k1',
      target_event_id: 't1',
      creator_pubkey: 'pub1',
      status: 'failed:transient:blossom_5xx',
      accepted_at: new Date(1700000000000 - 300_000).toISOString(),
      blob_sha256: null,
      retry_count: 2,
      last_error: 'HTTP 503: prior attempt',
      completed_at: null
    });

    await deps.kv.put('creator-delete-cron:last-poll', String(Date.now() - 30_000));
    deps.queryKind5Since.mockResolvedValueOnce([]); // no new events
    deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const result = await runCreatorDeleteCron(deps);
    expect(deps.callBlossomDelete).toHaveBeenCalledWith(SHA_C);
    expect(result.processed).toBeGreaterThanOrEqual(1);
  });
});
