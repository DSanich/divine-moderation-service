// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it, vi } from 'vitest';
import {
  buildWranglerExecuteArgs,
  buildPersistReplicaSqlChunks,
  buildSparseModerationRowsQuery,
  createCloudflareApiD1Client,
  loadCheckpoint,
  parseWranglerWhoamiAccountId,
  processReplicaBatch,
  runReplicaBackfill,
  saveCheckpoint,
} from './backfill-relay-replica.mjs';

describe('backfill-relay-replica', () => {
  it('builds sparse moderation query with stable cursor pagination', () => {
    const { sql } = buildSparseModerationRowsQuery({
      cursor: {
        priority_bucket: 2,
        moderated_at: '2026-04-16T00:00:00.000Z',
        sha256: 'f'.repeat(64)
      },
      limit: 250
    });

    expect(sql).toContain('FROM moderation_results');
    expect(sql).toContain("uploaded_by IS NULL OR uploaded_by = ''");
    expect(sql).toContain("moderated_at < '2026-04-16T00:00:00.000Z'");
    expect(sql).toContain(`sha256 < '${'f'.repeat(64)}'`);
    expect(sql).toContain("CASE");
    expect(sql).toContain("END > 2");
    expect(sql).toContain('ORDER BY priority_bucket ASC, moderated_at DESC, sha256 DESC');
    expect(sql).toContain('LIMIT 250');
  });

  it('prioritizes REVIEW rows before quick-review flagged rows before the rest', () => {
    const { sql } = buildSparseModerationRowsQuery({
      cursor: {
        priority_bucket: 1,
        moderated_at: '2026-04-16T00:00:00.000Z',
        sha256: 'f'.repeat(64)
      },
      limit: 250
    });

    expect(sql).toContain("WHEN action = 'REVIEW' AND reviewed_by IS NULL THEN 0");
    expect(sql).toContain("WHEN action IN ('AGE_RESTRICTED', 'PERMANENT_BAN') AND reviewed_by IS NULL THEN 1");
    expect(sql).toContain("ELSE 2");
    expect(sql).toContain("END > 1");
    expect(sql).toContain("priority_bucket ASC, moderated_at DESC, sha256 DESC");
  });

  it('parses the Cloudflare account id from wrangler whoami output', () => {
    const accountId = parseWranglerWhoamiAccountId(`
👋 You are logged in with an OAuth Token, associated with the email rabble@verse.app.
┌──────────────┬──────────────────────────────────┐
│ Account Name │ Account ID                       │
├──────────────┼──────────────────────────────────┤
│ Divine       │ c84e7a9bf7ed99cb41b8e73566568c75 │
└──────────────┴──────────────────────────────────┘
`);

    expect(accountId).toBe('c84e7a9bf7ed99cb41b8e73566568c75');
  });

  it('saves and loads checkpoint state', async () => {
    const store = new Map();
    const fsMod = {
      async mkdir() {},
      async writeFile(file, value) { store.set(file, value); },
      async readFile(file) {
        if (!store.has(file)) throw new Error('missing');
        return store.get(file);
      }
    };
    const checkpointFile = '/tmp/relay-replica-checkpoint-test.json';
    const checkpoint = {
      cursor: {
        moderated_at: '2026-04-15T00:00:00.000Z',
        sha256: 'a'.repeat(64)
      },
      stats: {
        scanned: 12,
        repaired: 7,
        unresolved: 3,
        failed: 2,
        batches: 1
      }
    };

    await saveCheckpoint(checkpointFile, checkpoint, { fsMod });
    const loaded = await loadCheckpoint(checkpointFile, { fsMod });

    expect(loaded).toEqual(checkpoint);
  });

  it('processes a batch and reports repaired, unresolved, and failed rows', async () => {
    const rows = [
      { sha256: 'a'.repeat(64), moderated_at: '2026-04-16T02:00:00.000Z' },
      { sha256: 'b'.repeat(64), moderated_at: '2026-04-16T01:00:00.000Z' },
      { sha256: 'c'.repeat(64), moderated_at: '2026-04-16T00:00:00.000Z' }
    ];

    const result = await processReplicaBatch(rows, {
      concurrency: 2,
      fetchVideoBySha: vi.fn(async (sha256) => {
        if (sha256 === 'a'.repeat(64)) {
          return {
            event: {
              id: 'e'.repeat(64),
              pubkey: 'f'.repeat(64),
              created_at: 1700000000,
              tags: [
                ['d', 'stable-a'],
                ['title', 'Video A'],
                ['published_at', '1389756506'],
                ['imeta', `url https://media.divine.video/${sha256}.mp4`, `x ${sha256}`]
              ],
              content: 'Body A'
            },
            stats: { author_name: 'Author A' }
          };
        }
        if (sha256 === 'b'.repeat(64)) {
          return null;
        }
        throw new Error('boom');
      }),
      fetchBulkProfiles: vi.fn(async () => ({
        ['f'.repeat(64)]: {
          display_name: 'Bulk A',
          name: 'bulk-a',
          picture: 'https://cdn.divine.video/bulk-a.jpg'
        }
      })),
      fetchUser: vi.fn(async () => ({
        stats: {
          video_count: 10,
          total_events: 30,
          first_activity: '2020-01-01T00:00:00.000Z',
          last_activity: '2026-04-01T00:00:00.000Z'
        }
      })),
      fetchUserSocial: vi.fn(async () => ({
        follower_count: 50,
        following_count: 5
      })),
      upsertRelayVideo: vi.fn(async () => {}),
      upsertRelayCreator: vi.fn(async () => {}),
      refreshModerationResult: vi.fn(async () => {}),
      log: () => {}
    });

    expect(result.stats).toMatchObject({
      scanned: 3,
      repaired: 1,
      unresolved: 1,
      failed: 1
    });
    expect(result.cursor).toEqual({
      priority_bucket: 2,
      moderated_at: '2026-04-16T00:00:00.000Z',
      sha256: 'c'.repeat(64)
    });
  });

  it('batches repaired rows into one persistence call per batch', async () => {
    const rows = [
      { sha256: 'a'.repeat(64), moderated_at: '2026-04-16T02:00:00.000Z' },
      { sha256: 'b'.repeat(64), moderated_at: '2026-04-16T01:00:00.000Z' }
    ];
    const persistReplicaBatch = vi.fn(async () => {});

    const result = await processReplicaBatch(rows, {
      fetchVideoBySha: vi.fn(async (sha256) => ({
        event: {
          id: sha256.replace(/a|b/g, 'e').slice(0, 64),
          pubkey: `${sha256[0]}`.repeat(64),
          created_at: 1700000000,
          tags: [
            ['d', `stable-${sha256[0]}`],
            ['title', `Video ${sha256[0]}`],
            ['published_at', '1389756506'],
            ['imeta', `url https://media.divine.video/${sha256}.mp4`, `x ${sha256}`]
          ],
          content: `Body ${sha256[0]}`
        },
        stats: { author_name: `Author ${sha256[0]}` }
      })),
      fetchBulkProfiles: vi.fn(async () => ({})),
      fetchUser: vi.fn(async () => null),
      fetchUserSocial: vi.fn(async () => null),
      persistReplicaBatch,
      upsertRelayVideo: vi.fn(async () => {}),
      upsertRelayCreator: vi.fn(async () => {}),
      refreshModerationResult: vi.fn(async () => {}),
      log: () => {}
    });

    expect(result.stats).toMatchObject({
      scanned: 2,
      repaired: 2,
      unresolved: 0,
      failed: 0
    });
    expect(persistReplicaBatch).toHaveBeenCalledTimes(1);
    expect(persistReplicaBatch).toHaveBeenCalledWith({
      videos: expect.arrayContaining([
        expect.objectContaining({ sha256: 'a'.repeat(64) }),
        expect.objectContaining({ sha256: 'b'.repeat(64) })
      ]),
      creators: expect.arrayContaining([
        expect.objectContaining({ pubkey: 'a'.repeat(64) }),
        expect.objectContaining({ pubkey: 'b'.repeat(64) })
      ]),
      moderationUpdates: expect.arrayContaining([
        expect.objectContaining({ sha256: 'a'.repeat(64) }),
        expect.objectContaining({ sha256: 'b'.repeat(64) })
      ])
    });
  });

  it('fetches creator context in bulk once per batch instead of per repaired row', async () => {
    const rows = [
      { sha256: 'a'.repeat(64), moderated_at: '2026-04-16T02:00:00.000Z' },
      { sha256: 'b'.repeat(64), moderated_at: '2026-04-16T01:00:00.000Z' },
      { sha256: 'c'.repeat(64), moderated_at: '2026-04-16T00:00:00.000Z' }
    ];
    const sharedPubkey = 'f'.repeat(64);
    const fetchBulkUsers = vi.fn(async (pubkeys) => Object.fromEntries(
      pubkeys.map((pubkey) => [pubkey, {
        pubkey,
        profile: {
          display_name: `Creator ${pubkey.slice(0, 4)}`,
          name: `creator-${pubkey.slice(0, 4)}`,
          picture: `https://cdn.divine.video/${pubkey}.jpg`
        },
        social: {
          follower_count: 11,
          following_count: 3
        },
        stats: {
          video_count: 7,
          total_events: 21,
          first_activity: '2020-01-01T00:00:00.000Z',
          last_activity: '2026-04-01T00:00:00.000Z'
        },
        engagement: {
          total_reactions: 99
        }
      }])
    ));
    const fetchUser = vi.fn(async () => {
      throw new Error('per-user fetch should not run');
    });
    const fetchUserSocial = vi.fn(async () => {
      throw new Error('per-user social fetch should not run');
    });

    const result = await processReplicaBatch(rows, {
      fetchVideoBySha: vi.fn(async (sha256) => ({
        event: {
          id: sha256.replace(/[abc]/g, 'e').slice(0, 64),
          pubkey: sha256 === 'c'.repeat(64) ? '9'.repeat(64) : sharedPubkey,
          created_at: 1700000000,
          tags: [
            ['d', `stable-${sha256[0]}`],
            ['title', `Video ${sha256[0]}`],
            ['published_at', '1389756506'],
            ['imeta', `url https://media.divine.video/${sha256}.mp4`, `x ${sha256}`]
          ],
          content: `Body ${sha256[0]}`
        },
        stats: { author_name: `Author ${sha256[0]}` }
      })),
      fetchBulkUsers,
      fetchUser,
      fetchUserSocial,
      persistReplicaBatch: vi.fn(async () => {}),
      upsertRelayVideo: vi.fn(async () => {}),
      upsertRelayCreator: vi.fn(async () => {}),
      refreshModerationResult: vi.fn(async () => {}),
      log: () => {}
    });

    expect(result.stats).toMatchObject({
      scanned: 3,
      repaired: 3,
      unresolved: 0,
      failed: 0
    });
    expect(fetchBulkUsers).toHaveBeenCalledTimes(1);
    expect(fetchBulkUsers).toHaveBeenCalledWith([
      sharedPubkey,
      '9'.repeat(64)
    ]);
    expect(fetchUser).not.toHaveBeenCalled();
    expect(fetchUserSocial).not.toHaveBeenCalled();
  });

  it('builds chunked batched SQL for replica persistence', () => {
    const video = {
      sha256: 'a'.repeat(64),
      event_id: 'e'.repeat(64),
      stable_id: 'stable-a',
      pubkey: 'f'.repeat(64),
      title: 'Video A',
      content: 'Body A',
      summary: 'Summary A',
      video_url: 'https://media.divine.video/a.mp4',
      thumbnail_url: 'https://media.divine.video/a.jpg',
      published_at: 1389756506,
      created_at: 1389756400,
      author_name: 'Author A',
      author_avatar: 'https://media.divine.video/avatar-a.jpg',
      raw_json: '{"video":"a"}',
      synced_at: '2026-04-16T00:00:00.000Z',
      source_updated_at: null
    };
    const creator = {
      pubkey: 'f'.repeat(64),
      display_name: 'Creator A',
      username: 'creator-a',
      avatar_url: 'https://media.divine.video/avatar-a.jpg',
      bio: 'Bio A',
      website: 'https://divine.video/a',
      nip05: 'creator-a@divine.video',
      follower_count: 10,
      following_count: 5,
      video_count: 3,
      event_count: 12,
      first_activity: '2020-01-01T00:00:00.000Z',
      last_activity: '2026-04-15T00:00:00.000Z',
      raw_json: '{"creator":"a"}',
      synced_at: '2026-04-16T00:00:00.000Z'
    };

    const chunks = buildPersistReplicaSqlChunks({
      videos: [video, { ...video, sha256: 'b'.repeat(64), stable_id: 'stable-b' }],
      creators: [creator],
      moderationUpdates: [
        {
          sha256: 'a'.repeat(64),
          uploaded_by: 'f'.repeat(64),
          title: 'Video A',
          author: 'Creator A',
          event_id: 'e'.repeat(64),
          content_url: 'https://media.divine.video/a.mp4',
          published_at: 1389756506
        },
        {
          sha256: 'b'.repeat(64),
          uploaded_by: 'f'.repeat(64),
          title: 'Video B',
          author: 'Creator A',
          event_id: 'd'.repeat(64),
          content_url: 'https://media.divine.video/b.mp4',
          published_at: 1389756507
        }
      ]
    }, { chunkSize: 1 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('INSERT INTO relay_videos');
    expect(chunks[0]).toContain('ON CONFLICT(sha256) DO UPDATE SET');
    expect(chunks[0]).toContain('INSERT INTO relay_creators');
    expect(chunks[0]).toContain('UPDATE moderation_results');
    expect(chunks[0]).toContain('source_updated_at = excluded.source_updated_at;');
    expect(chunks[0]).toContain('synced_at = excluded.synced_at;');
    expect(chunks[0]).toContain('CASE sha256');
    expect(chunks[1]).toContain('INSERT INTO relay_videos');
    expect(chunks[1]).toContain("WHERE sha256 IN ('bbbbbbbbbbbbbbbb");
    expect(chunks.every((chunk) => !chunk.includes('BEGIN TRANSACTION'))).toBe(true);
  });

  it('uses wrangler command execution for large SQL payloads by default', () => {
    const longSql = 'SELECT 1;\n'.repeat(20000);
    const invocation = buildWranglerExecuteArgs({
      databaseName: 'blossom-webhook-events',
      remote: true,
      wranglerBin: 'npx',
      sql: longSql,
      tempFile: '/tmp/backfill.sql'
    });

    expect(invocation).toEqual({
      command: 'npx',
      args: [
        'wrangler',
        'd1',
        'execute',
        'blossom-webhook-events',
        '--remote',
        '--json',
        '--command',
        longSql
      ]
    });
  });

  it('executes D1 SQL directly through the Cloudflare API when credentials are available', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          success: true,
          result: [
            {
              success: true,
              results: [{ x: 1 }]
            }
          ]
        };
      }
    }));

    const client = createCloudflareApiD1Client({
      accountId: 'c84e7a9bf7ed99cb41b8e73566568c75',
      databaseId: '829f06cf-294b-4491-8611-30fc53df2589',
      apiToken: 'test-token',
      fetchImpl
    });

    const rows = await client.querySparseRows({ limit: 1 });

    expect(rows).toEqual([{ x: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/c84e7a9bf7ed99cb41b8e73566568c75/d1/database/829f06cf-294b-4491-8611-30fc53df2589/query',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        }),
        body: expect.stringContaining('"sql"')
      })
    );
  });

  it('splits persistence chunks when rendered SQL exceeds the max size', () => {
    const hugeContent = 'x'.repeat(5000);
    const baseVideo = {
      event_id: 'e'.repeat(64),
      pubkey: 'f'.repeat(64),
      title: 'Video',
      content: hugeContent,
      summary: hugeContent,
      video_url: 'https://media.divine.video/a.mp4',
      thumbnail_url: 'https://media.divine.video/a.jpg',
      published_at: 1389756506,
      created_at: 1389756400,
      author_name: 'Author',
      author_avatar: 'https://media.divine.video/avatar-a.jpg',
      raw_json: JSON.stringify({ hugeContent }),
      synced_at: '2026-04-16T00:00:00.000Z',
      source_updated_at: null
    };

    const chunks = buildPersistReplicaSqlChunks({
      videos: [
        { ...baseVideo, sha256: 'a'.repeat(64), stable_id: 'stable-a' },
        { ...baseVideo, sha256: 'b'.repeat(64), stable_id: 'stable-b' }
      ],
      creators: [
        {
          pubkey: 'f'.repeat(64),
          display_name: 'Creator A',
          username: 'creator-a',
          avatar_url: 'https://media.divine.video/avatar-a.jpg',
          bio: 'Bio A',
          website: 'https://divine.video/a',
          nip05: 'creator-a@divine.video',
          follower_count: 10,
          following_count: 5,
          video_count: 3,
          event_count: 12,
          first_activity: '2020-01-01T00:00:00.000Z',
          last_activity: '2026-04-15T00:00:00.000Z',
          raw_json: '{"creator":"a"}',
          synced_at: '2026-04-16T00:00:00.000Z'
        }
      ],
      moderationUpdates: [
        {
          sha256: 'a'.repeat(64),
          uploaded_by: 'f'.repeat(64),
          title: 'Video A',
          author: 'Creator A',
          event_id: 'e'.repeat(64),
          content_url: 'https://media.divine.video/a.mp4',
          published_at: 1389756506
        },
        {
          sha256: 'b'.repeat(64),
          uploaded_by: 'f'.repeat(64),
          title: 'Video B',
          author: 'Creator A',
          event_id: 'd'.repeat(64),
          content_url: 'https://media.divine.video/b.mp4',
          published_at: 1389756507
        }
      ]
    }, { chunkSize: 10, maxSqlLength: 12000 });

    expect(chunks).toHaveLength(2);
  });

  it('resumes from checkpoint cursor without restarting from the beginning', async () => {
    const rows = [
      { sha256: 'd'.repeat(64), moderated_at: '2026-04-16T03:00:00.000Z' },
      { sha256: 'c'.repeat(64), moderated_at: '2026-04-16T02:00:00.000Z' },
      { sha256: 'b'.repeat(64), moderated_at: '2026-04-16T01:00:00.000Z' },
      { sha256: 'a'.repeat(64), moderated_at: '2026-04-16T00:00:00.000Z' }
    ];
    const processed = [];
    let storedCheckpoint = null;

    const querySparseRows = vi.fn(async ({ cursor, limit }) => {
      const startIndex = cursor
        ? rows.findIndex((row) => row.moderated_at === cursor.moderated_at && row.sha256 === cursor.sha256) + 1
        : 0;
      return rows.slice(startIndex, startIndex + limit);
    });

    const deps = {
      querySparseRows,
      fetchVideoBySha: vi.fn(async (sha256) => ({
        event: {
          id: sha256.replace(/a|b|c|d/g, 'e').slice(0, 64),
          pubkey: 'f'.repeat(64),
          created_at: 1700000000,
          tags: [
            ['d', `stable-${sha256[0]}`],
            ['title', `Video ${sha256[0]}`],
            ['published_at', '1389756506'],
            ['imeta', `url https://media.divine.video/${sha256}.mp4`, `x ${sha256}`]
          ],
          content: `Body ${sha256[0]}`
        },
        stats: { author_name: `Author ${sha256[0]}` }
      })),
      fetchBulkProfiles: vi.fn(async () => ({
        ['f'.repeat(64)]: {
          display_name: 'Bulk Creator',
          name: 'bulk-creator',
          picture: 'https://cdn.divine.video/bulk.jpg'
        }
      })),
      fetchUser: vi.fn(async () => ({
        stats: {
          video_count: 4,
          total_events: 8,
          first_activity: '2020-01-01T00:00:00.000Z',
          last_activity: '2026-04-01T00:00:00.000Z'
        }
      })),
      fetchUserSocial: vi.fn(async () => ({
        follower_count: 9,
        following_count: 3
      })),
      upsertRelayVideo: vi.fn(async (record) => { processed.push(record.sha256); }),
      upsertRelayCreator: vi.fn(async () => {}),
      refreshModerationResult: vi.fn(async () => {}),
      loadCheckpoint: vi.fn(async () => storedCheckpoint),
      saveCheckpoint: vi.fn(async (_path, checkpoint) => { storedCheckpoint = checkpoint; }),
      log: () => {}
    };

    const firstRun = await runReplicaBackfill({
      batchSize: 2,
      maxBatches: 1,
      checkpointFile: '/tmp/test-checkpoint.json'
    }, deps);

    expect(firstRun.completed).toBe(false);
    expect(processed).toEqual(['d'.repeat(64), 'c'.repeat(64)]);
    expect(storedCheckpoint.cursor).toEqual({
      priority_bucket: 2,
      moderated_at: '2026-04-16T02:00:00.000Z',
      sha256: 'c'.repeat(64)
    });

    const secondRun = await runReplicaBackfill({
      batchSize: 2,
      checkpointFile: '/tmp/test-checkpoint.json'
    }, deps);

    expect(secondRun.completed).toBe(true);
    expect(processed).toEqual([
      'd'.repeat(64),
      'c'.repeat(64),
      'b'.repeat(64),
      'a'.repeat(64)
    ]);
    expect(storedCheckpoint.cursor).toEqual({
      priority_bucket: 2,
      moderated_at: '2026-04-16T00:00:00.000Z',
      sha256: 'a'.repeat(64)
    });
  });
});
