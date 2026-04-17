// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for classic Vine downgrade script helpers
// ABOUTME: Verifies legacy Vine candidate extraction and conservative eligibility filtering

import { describe, expect, it } from 'vitest';
import {
  buildAgeRestrictedUpdate,
  classifyDecisionForDowngrade,
  extractClassicVineCandidateFromEvent,
  runClassicVineAgeRestrictionDowngrade
} from './downgrade-classic-vines-to-age-restricted.mjs';

describe('extractClassicVineCandidateFromEvent', () => {
  it('extracts a candidate from a legacy Vine event using x/imeta x media hash', () => {
    const sha256 = 'a'.repeat(64);
    const event = {
      id: 'b'.repeat(64),
      content: '',
      created_at: 1465948644,
      tags: [
        ['d', 'legacy-vine-id'],
        ['x', sha256],
        ['imeta', `url https://media.divine.video/${sha256}`, 'm video/mp4', `x ${sha256}`],
        ['platform', 'vine'],
        ['client', 'vine-archive-importer'],
        ['r', 'https://vine.co/v/legacy-vine-id'],
        ['published_at', '1465948644']
      ]
    };

    expect(extractClassicVineCandidateFromEvent(event)).toEqual({
      sha256,
      eventId: event.id,
      nostrContext: expect.objectContaining({
        platform: 'vine',
        client: 'vine-archive-importer',
        sourceUrl: 'https://vine.co/v/legacy-vine-id',
        publishedAt: 1465948644
      })
    });
  });

  it('returns null for non-Vine events', () => {
    const event = {
      id: 'b'.repeat(64),
      content: '',
      created_at: 1700000000,
      tags: [
        ['d', 'not-vine'],
        ['x', 'a'.repeat(64)],
        ['platform', 'divine']
      ]
    };

    expect(extractClassicVineCandidateFromEvent(event)).toBeNull();
  });
});

describe('classifyDecisionForDowngrade', () => {
  it('marks machine-applied non-SAFE rows as eligible', () => {
    const decision = {
      sha256: 'a'.repeat(64),
      action: 'PERMANENT_BAN',
      reviewed_by: null,
      review_notes: null
    };

    expect(classifyDecisionForDowngrade(decision)).toEqual({
      eligible: true,
      reason: 'eligible-machine-restriction'
    });
  });

  it('skips rows with reviewed_by set', () => {
    expect(classifyDecisionForDowngrade({
      sha256: 'a'.repeat(64),
      action: 'QUARANTINE',
      reviewed_by: 'admin',
      review_notes: null
    })).toEqual({
      eligible: false,
      reason: 'human-reviewed'
    });
  });

  it('skips rows with review_notes set', () => {
    expect(classifyDecisionForDowngrade({
      sha256: 'a'.repeat(64),
      action: 'AGE_RESTRICTED',
      reviewed_by: null,
      review_notes: 'manual T&S action'
    })).toEqual({
      eligible: false,
      reason: 'review-notes-present'
    });
  });

  it('skips SAFE rows', () => {
    expect(classifyDecisionForDowngrade({
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      reviewed_by: null,
      review_notes: null
    })).toEqual({
      eligible: false,
      reason: 'already-safe'
    });
  });

  it('skips rows already age-restricted', () => {
    expect(classifyDecisionForDowngrade({
      sha256: 'a'.repeat(64),
      action: 'AGE_RESTRICTED',
      reviewed_by: null,
      review_notes: null
    })).toEqual({
      eligible: false,
      reason: 'already-age-restricted'
    });
  });

  it('skips missing rows', () => {
    expect(classifyDecisionForDowngrade(null)).toEqual({
      eligible: false,
      reason: 'no-decision'
    });
  });
});

describe('buildAgeRestrictedUpdate', () => {
  it('builds the expected moderation update payload', () => {
    const sha256 = 'a'.repeat(64);
    expect(buildAgeRestrictedUpdate(sha256)).toEqual({
      sha256,
      action: 'AGE_RESTRICTED',
      reason: 'classic-vine-downgrade: machine-applied legacy Vine restriction downgraded to age-restricted',
      source: 'classic-vine-downgrade-script'
    });
  });
});

describe('runClassicVineAgeRestrictionDowngrade', () => {
  it('reports eligible rows in preview mode without updating them', async () => {
    const sha256 = 'a'.repeat(64);

    const report = await runClassicVineAgeRestrictionDowngrade({
      mode: 'preview',
      apiToken: 'token',
      relayUrl: 'wss://relay.example',
      workerUrl: 'https://worker.example'
    }, {
      discoverCandidates: async () => [{ sha256, eventId: 'b'.repeat(64) }],
      fetch: async () => ({
        ok: true,
        json: async () => ({
          sha256,
          action: 'PERMANENT_BAN',
          reviewed_by: null,
          review_notes: null
        })
      })
    });

    expect(report.stats.eligible).toBe(1);
    expect(report.stats.updated).toBe(0);
    expect(report.results).toEqual([
      {
        sha256,
        eventId: 'b'.repeat(64),
        result: 'eligible'
      }
    ]);
  });

  it('updates eligible rows in execute mode', async () => {
    const sha256 = 'a'.repeat(64);
    let updateCalls = 0;

    const report = await runClassicVineAgeRestrictionDowngrade({
      mode: 'execute',
      apiToken: 'token',
      relayUrl: 'wss://relay.example',
      workerUrl: 'https://worker.example'
    }, {
      discoverCandidates: async () => [{ sha256, eventId: 'b'.repeat(64) }],
      fetch: async (url, init = {}) => {
        if (String(url).includes('/api/v1/decisions/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              sha256,
              action: 'QUARANTINE',
              reviewed_by: null,
              review_notes: null
            })
          };
        }

        updateCalls++;
        expect(JSON.parse(init.body)).toEqual(buildAgeRestrictedUpdate(sha256));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, sha256, action: 'AGE_RESTRICTED' })
        };
      }
    });

    expect(updateCalls).toBe(1);
    expect(report.stats.updated).toBe(1);
    expect(report.results[0]).toEqual({
      sha256,
      eventId: 'b'.repeat(64),
      result: 'updated',
      response: { success: true, sha256, action: 'AGE_RESTRICTED' }
    });
  });

  it('uses admin lookup endpoints in preview mode when an admin session is provided', async () => {
    const sha256 = 'a'.repeat(64);
    const requests = [];

    const report = await runClassicVineAgeRestrictionDowngrade({
      mode: 'preview',
      relayUrl: 'wss://relay.example',
      workerUrl: 'https://worker.example',
      adminOrigin: 'https://moderation.admin.divine.video',
      cfAccessCookie: 'cf-cookie'
    }, {
      discoverCandidates: async () => [{ sha256, eventId: 'b'.repeat(64) }],
      fetch: async (url, init = {}) => {
        requests.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            video: {
              sha256,
              action: 'PERMANENT_BAN',
              reviewed_by: null,
              review_notes: null
            }
          })
        };
      }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: `https://moderation.admin.divine.video/admin/api/video/${sha256}`,
      init: {
        headers: {
          'Cookie': 'CF_Authorization=cf-cookie',
          'Content-Type': 'application/json'
        }
      }
    });
    expect(report.stats.eligible).toBe(1);
    expect(report.results[0]).toEqual({
      sha256,
      eventId: 'b'.repeat(64),
      result: 'eligible'
    });
  });

  it('uses admin moderate endpoints in execute mode when an admin session is provided', async () => {
    const sha256 = 'a'.repeat(64);
    const requests = [];

    const report = await runClassicVineAgeRestrictionDowngrade({
      mode: 'execute',
      relayUrl: 'wss://relay.example',
      workerUrl: 'https://worker.example',
      adminOrigin: 'https://moderation.admin.divine.video',
      cfAccessCookie: 'cf-cookie'
    }, {
      discoverCandidates: async () => [{ sha256, eventId: 'b'.repeat(64) }],
      fetch: async (url, init = {}) => {
        requests.push({ url: String(url), init });

        if (String(url).includes('/admin/api/video/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              video: {
                sha256,
                action: 'QUARANTINE',
                reviewed_by: null,
                review_notes: null
              }
            })
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, sha256, action: 'AGE_RESTRICTED' })
        };
      }
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      url: `https://moderation.admin.divine.video/admin/api/moderate/${sha256}`,
      init: {
        method: 'POST',
        headers: {
          'Cookie': 'CF_Authorization=cf-cookie',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'AGE_RESTRICTED',
          reason: 'classic-vine-downgrade: machine-applied legacy Vine restriction downgraded to age-restricted'
        })
      }
    });
    expect(report.stats.updated).toBe(1);
    expect(report.results[0]).toEqual({
      sha256,
      eventId: 'b'.repeat(64),
      result: 'updated',
      response: { success: true, sha256, action: 'AGE_RESTRICTED' }
    });
  });
});
