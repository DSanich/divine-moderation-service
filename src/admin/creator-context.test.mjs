// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it, vi } from 'vitest';
import { buildCreatorContext } from './creator-context.mjs';

describe('buildCreatorContext', () => {
  it('merges local moderation stats with Funnelcake profile and social data', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pubkey: 'f'.repeat(64),
        profile: {
          display_name: 'Alice',
          name: 'alice',
          picture: 'https://cdn.example.com/alice.png',
        },
        stats: {
          video_count: 12,
          total_events: 88,
          first_activity: '2019-01-01T00:00:00.000Z',
          last_activity: '2026-04-14T00:00:00.000Z',
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        follower_count: 100,
        following_count: 20,
      }), {
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await buildCreatorContext({
      pubkey: 'f'.repeat(64),
      uploaderStats: {
        total_scanned: 5,
        flagged_count: 2,
        restricted_count: 1,
        banned_count: 0,
        review_count: 1,
        risk_level: 'elevated',
      },
      uploaderEnforcement: {
        approval_required: false,
        relay_banned: true,
      },
    }, { fetchFn });

    expect(result.name).toBe('Alice');
    expect(result.stats.totalScanned).toBe(5);
    expect(result.social.followerCount).toBe(100);
    expect(result.social.videoCount).toBe(12);
    expect(result.enforcement.relayBanned).toBe(true);
  });

  it('returns local-only context when api.divine.video fails', async () => {
    const result = await buildCreatorContext({
      pubkey: 'f'.repeat(64),
      uploaderStats: {
        total_scanned: 2,
        flagged_count: 0,
        restricted_count: 0,
        banned_count: 0,
        review_count: 0,
        risk_level: 'normal',
      },
      uploaderEnforcement: {
        approval_required: false,
        relay_banned: false,
      },
    }, {
      fetchFn: vi.fn().mockRejectedValue(new Error('boom')),
    });

    expect(result.stats.totalScanned).toBe(2);
    expect(result.social).toBeNull();
    expect(result.name).toBeNull();
  });
});
