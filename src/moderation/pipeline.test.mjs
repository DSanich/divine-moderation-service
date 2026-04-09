// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for full moderation pipeline orchestration
// ABOUTME: Verifies end-to-end flow from video URL to classified result

import { afterEach, describe, it, expect, vi } from 'vitest';
import { moderateVideo } from './pipeline.mjs';

const OriginalWebSocket = globalThis.WebSocket;

function createNostrLookupWebSocket(event) {
  return class FakeWebSocket {
    constructor() {
      this.listeners = {};
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }

    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    }

    send(message) {
      const [, subscriptionId] = JSON.parse(message);
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
        this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
      });
    }

    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }

    emit(type, payload = {}) {
      for (const handler of this.listeners[type] || []) {
        handler(payload);
      }
    }
  };
}

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe('Moderation Pipeline', () => {
  it('should run full pipeline and return SAFE classification', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.05 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }, violence: { prob: 0.1 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 }, violence: { prob: 0.03 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'a'.repeat(64),
      r2Key: 'videos/test.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('SAFE');
    expect(result.severity).toBe('low');
    expect(result.scores).toBeDefined();
  });

  it('skips transcript analysis while Blossom reports VTT generation is pending', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: true,
          status: 202,
          headers: {
            get(name) {
              return name === 'Retry-After' ? '12' : null;
            }
          },
          text: async () => '{"status":"processing"}'
        };
      }

      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            frames: [
              { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.05 } }
            ]
          }
        })
      };
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'c'.repeat(64),
      r2Key: 'videos/pending-transcript.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('SAFE');
    expect(result.text_scores).toBeNull();
    expect(result.topicProfile).toBeNull();
  });

  it('keeps benign Hive nudity SAFE while retaining downstream nudity signals', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: false,
          status: 404,
          text: async () => ''
        };
      }

      if (typeof url === 'string' && url.includes('api.thehive.ai')) {
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [
                  {
                    time: 0,
                    classes: [
                      { class: 'yes_male_nudity', score: 0.91 },
                      { class: 'yes_male_swimwear', score: 0.88 },
                      { class: 'yes_male_underwear', score: 0.83 }
                    ]
                  }
                ]
              }
            }]
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${String(url)}`);
    });

    const env = {
      HIVE_MODERATION_API_KEY: 'mod-key',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'b'.repeat(64),
      r2Key: 'videos/shirtless.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.provider).toBe('hiveai');
    expect(result.action).toBe('SAFE');
    expect(result.scores.nudity).toBe(0.91);
    expect(result.scores.sexual).toBe(0);
    expect(result.scores.porn).toBe(0);
    expect(result.downstreamSignals?.hasSignals).toBe(true);
    expect(result.downstreamSignals?.scores?.nudity).toBe(0.91);
    expect(result.downstreamSignals?.primaryConcern).toBe('nudity');
  });

  it('should detect Hive sexual content and return AGE_RESTRICTED', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: false,
          status: 404,
          text: async () => ''
        };
      }

      if (typeof url === 'string' && url.includes('api.thehive.ai')) {
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [
                  {
                    time: 0,
                    classes: [
                      { class: 'yes_sexual_display', score: 0.9 },
                      { class: 'yes_sex_toy', score: 0.82 }
                    ]
                  }
                ]
              }
            }]
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${String(url)}`);
    });

    const env = {
      HIVE_MODERATION_API_KEY: 'mod-key',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'n'.repeat(64),
      r2Key: 'videos/sexual-display.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.provider).toBe('hiveai');
    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.category).toBe('sexual');
    expect(result.scores.sexual).toBe(0.9);
    expect(result.scores.porn).toBe(0);
  });

  it('should detect borderline violence and return REVIEW', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.65 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }, violence: { prob: 0.55 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 }, violence: { prob: 0.6 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'c'.repeat(64),
      r2Key: 'videos/borderline.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.severity).toBe('medium');
    expect(result.primaryConcern).toBe('violence');
  });

  it('should detect high violence and return AGE_RESTRICTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.82 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }, violence: { prob: 0.75 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 }, violence: { prob: 0.78 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'v'.repeat(64),
      r2Key: 'videos/violent.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
    expect(result.primaryConcern).toBe('violence');
    expect(result.category).toBe('violence');
  });

  it('should construct correct CDN URL from sha256', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { frames: [
          { info: { position: 0 }, nudity: { raw: 0.1, safe: 0.9 }, violence: { prob: 0.05 } }
        ]}
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const sha256 = 'd'.repeat(64);
    await moderateVideo({
      sha256,
      r2Key: 'videos/test.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    // Check that Sightengine was called with correct URL (URL encoded)
    const callUrl = mockFetch.mock.calls[0][0];
    const decodedUrl = decodeURIComponent(callUrl);
    expect(decodedUrl).toContain(`https://cdn.divine.video/${sha256}`);
  });

  it('should include metadata in result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { frames: [
          { info: { position: 0 }, nudity: { raw: 0.1, safe: 0.9 }, violence: { prob: 0.05 } }
        ]}
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const uploadedAt = Date.now();
    const result = await moderateVideo({
      sha256: 'e'.repeat(64),
      r2Key: 'videos/test.mp4',
      uploadedBy: 'f'.repeat(64),
      uploadedAt,
      metadata: { fileSize: 1024000 }
    }, env, mockFetch);

    expect(result.sha256).toBe('e'.repeat(64));
    expect(result.uploadedBy).toBe('f'.repeat(64));
    expect(result.uploadedAt).toBe(uploadedAt);
  });

  it('should handle Sightengine API errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    await expect(
      moderateVideo({
        sha256: 'g'.repeat(64),
        r2Key: 'videos/test.mp4',
        uploadedAt: Date.now()
      }, env, mockFetch)
    ).rejects.toThrow('Sightengine API error');
  });

  it('should require CDN_DOMAIN configuration', async () => {
    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    await expect(
      moderateVideo({
        sha256: 'h'.repeat(64),
        r2Key: 'videos/test.mp4',
        uploadedAt: Date.now()
      }, env)
    ).rejects.toThrow('CDN_DOMAIN not configured');
  });

  it('keeps imported original vines SAFE while retaining raw AI scores', async () => {
    const sha256 = 'i'.repeat(64);
    globalThis.WebSocket = createNostrLookupWebSocket({
      id: 'evt-original-vine',
      content: 'classic archive vine',
      created_at: 1700000000,
      tags: [
        ['d', sha256],
        ['platform', 'vine'],
        ['r', 'https://vine.co/v/abc123']
      ]
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            frames: [
              {
                info: { position: 0 },
                nudity: { raw: 0.05, partial: 0.03, safe: 0.92 },
                violence: { prob: 0.02 },
                type: { ai_generated: 0.96 }
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: async () => ''
      });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256,
      uploadedAt: Date.now(),
      metadata: { videoUrl: 'https://archive.example.com/original-vine.mp4' }
    }, env, mockFetch);

    expect(result.action).toBe('SAFE');
    expect(result.policyContext?.originalVine).toBe(true);
    expect(result.policyContext?.enforcementOverridden).toBe(true);
    expect(result.scores.ai_generated).toBe(0.96);
    expect(result.downstreamSignals?.scores?.ai_generated ?? 0).toBe(0);
    expect(result.downstreamSignals?.hasSignals).toBe(false);
  });

  it('keeps downstream moderation signals for original vines when non-AI scores are high', async () => {
    const sha256 = 'j'.repeat(64);
    globalThis.WebSocket = createNostrLookupWebSocket({
      id: 'evt-original-vine-signals',
      content: 'classic archive vine',
      created_at: 1700000000,
      tags: [
        ['d', sha256],
        ['platform', 'vine']
      ]
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            frames: [
              {
                info: { position: 0 },
                nudity: { raw: 0.86, partial: 0.2, safe: 0.1 },
                violence: { prob: 0.15 },
                type: { ai_generated: 0.82 }
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: async () => ''
      });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256,
      uploadedAt: Date.now(),
      metadata: { videoUrl: 'https://archive.example.com/original-vine-nudity.mp4' }
    }, env, mockFetch);

    expect(result.action).toBe('SAFE');
    expect(result.policyContext?.originalVine).toBe(true);
    expect(result.scores.nudity).toBe(0.86);
    expect(result.downstreamSignals?.hasSignals).toBe(true);
    expect(result.downstreamSignals?.scores?.nudity).toBe(0.86);
    expect(result.downstreamSignals?.scores?.ai_generated ?? 0).toBe(0);
    expect(result.downstreamSignals?.primaryConcern).toBe('nudity');
  });
});
