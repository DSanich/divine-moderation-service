// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Queue consumer regression tests for moderation worker
// ABOUTME: Verifies validated queue fields are forwarded into the moderation pipeline

import { describe, it, expect, vi, beforeEach } from 'vitest';

const moderateVideoMock = vi.fn();

function createDbMock({ writes = [] } = {}) {
  return {
    prepare(sql) {
      let bindings = [];

      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          writes.push({ sql, bindings });
          return { success: true, bindings };
        }
      };
    },
    async batch() {
      return [];
    }
  };
}

function createEnv(overrides = {}) {
  return {
    BLOSSOM_DB: createDbMock(),
    MODERATION_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true, cursor: null }; }
    },
    CDN_DOMAIN: 'media.divine.video',
    ...overrides
  };
}

describe('queue consumer', () => {
  beforeEach(() => {
    vi.resetModules();
    moderateVideoMock.mockReset();
    moderateVideoMock.mockResolvedValue({
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      severity: 'low',
      scores: { nudity: 0, violence: 0, ai_generated: 0 },
      categories: [],
      provider: 'mock-provider',
      rawClassifierData: null,
      sceneClassification: null,
      topicProfile: null,
      cdnUrl: `https://media.divine.video/${'a'.repeat(64)}`,
      uploadedBy: null,
      nostrContext: null
    });
  });

  it('forwards Video Seal fields from the queue message into moderateVideo', async () => {
    vi.doMock('./moderation/pipeline.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        moderateVideo: moderateVideoMock
      };
    });

    const { default: worker } = await import('./index.mjs');

    const ack = vi.fn();
    const retry = vi.fn();
    const payload = `01${'b'.repeat(62)}`;

    await worker.queue({
      messages: [{
        body: {
          sha256: 'a'.repeat(64),
          uploadedAt: Date.now(),
          metadata: { source: 'blossom' },
          videoSealPayload: payload,
          videoSealBitAccuracy: 0.93
        },
        attempts: 0,
        ack,
        retry
      }]
    }, createEnv());

    expect(moderateVideoMock).toHaveBeenCalledTimes(1);
    expect(moderateVideoMock).toHaveBeenCalledWith(expect.objectContaining({
      videoSealPayload: payload,
      videoSealBitAccuracy: 0.93
    }), expect.any(Object));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('persists the interpreted Video Seal signal in D1', async () => {
    const writes = [];
    const videoseal = {
      signal: 'videoseal',
      detected: true,
      source: 'divine',
      isAI: false,
      payload: `01${'d'.repeat(62)}`,
      confidence: 0.93
    };

    moderateVideoMock.mockResolvedValue({
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      severity: 'low',
      scores: { nudity: 0, violence: 0, ai_generated: 0 },
      categories: [],
      provider: 'mock-provider',
      rawClassifierData: null,
      sceneClassification: null,
      topicProfile: null,
      cdnUrl: `https://media.divine.video/${'a'.repeat(64)}`,
      uploadedBy: null,
      nostrContext: null,
      videoseal
    });

    vi.doMock('./moderation/pipeline.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        moderateVideo: moderateVideoMock
      };
    });

    const { default: worker } = await import('./index.mjs');

    await worker.queue({
      messages: [{
        body: {
          sha256: 'a'.repeat(64),
          uploadedAt: Date.now(),
          metadata: { source: 'blossom' },
          videoSealPayload: videoseal.payload,
          videoSealBitAccuracy: 0.93
        },
        attempts: 0,
        ack: vi.fn(),
        retry: vi.fn()
      }]
    }, createEnv({
      BLOSSOM_DB: createDbMock({ writes })
    }));

    const moderationWrite = writes.find(({ sql }) => sql.includes('INSERT OR REPLACE INTO moderation_results'));

    expect(moderationWrite).toBeDefined();
    expect(moderationWrite.sql).toContain('videoseal');
    expect(moderationWrite.bindings).toContain(JSON.stringify(videoseal));
  });
});
