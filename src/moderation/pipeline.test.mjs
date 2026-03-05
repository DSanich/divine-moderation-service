// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for full moderation pipeline orchestration
// ABOUTME: Verifies end-to-end flow from video URL to classified result

import { describe, it, expect, vi } from 'vitest';
import { moderateVideo } from './pipeline.mjs';

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

  it('should detect high nudity and return AGE_RESTRICTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.95, partial: 0.9, safe: 0.05 }, violence: { prob: 0.1 } },
            { info: { position: 3 }, nudity: { raw: 0.92, partial: 0.88, safe: 0.08 }, violence: { prob: 0.05 } },
            { info: { position: 6 }, nudity: { raw: 0.88, partial: 0.85, safe: 0.12 }, violence: { prob: 0.08 } }
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
      sha256: 'b'.repeat(64),
      r2Key: 'videos/bad.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
    expect(result.primaryConcern).toBe('nudity');
  });

  it('should detect borderline content and return REVIEW', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.65, partial: 0.6, safe: 0.35 }, violence: { prob: 0.2 } },
            { info: { position: 3 }, nudity: { raw: 0.6, partial: 0.55, safe: 0.4 }, violence: { prob: 0.25 } },
            { info: { position: 6 }, nudity: { raw: 0.55, partial: 0.5, safe: 0.45 }, violence: { prob: 0.15 } }
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
});
