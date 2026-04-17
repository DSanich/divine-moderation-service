// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Sightengine API integration
// ABOUTME: Verifies video moderation API calls and response handling

import { describe, it, expect, vi } from 'vitest';
import { moderateVideoWithSightengine } from './sightengine.mjs';

describe('Sightengine Integration', () => {
  it('should call Sightengine API with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/abcd1234.mp4',
      { sha256: 'abcd1234' },
      env,
      mockFetch
    );

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.sightengine.com/1.0/video/check-sync.json'),
      expect.objectContaining({
        method: 'GET'
      })
    );

    // Verify URL contains required parameters
    const callUrl = mockFetch.mock.calls[0][0];
    expect(callUrl).toContain('stream_url=');
    expect(callUrl).toContain('test-user');
    expect(callUrl).toContain('test-secret');

    expect(result.status).toBe('success');
    expect(result.frames).toHaveLength(3);
  });

  it('should extract max scores from frames', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: { raw: 0.1, partial: 0.05, safe: 0.85 },
              violence: { prob: 0.05 }
            },
            {
              info: { position: 3 },
              nudity: { raw: 0.85, partial: 0.7, safe: 0.15 },
              violence: { prob: 0.15 }
            },
            {
              info: { position: 6 },
              nudity: { raw: 0.2, partial: 0.1, safe: 0.7 },
              violence: { prob: 0.9 }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.maxScores.nudity).toBe(0.85);
    expect(result.maxScores.violence).toBe(0.9);
  });

  it('should handle API errors gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests'
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    await expect(
      moderateVideoWithSightengine('https://cdn.divine.video/test.mp4', {}, env, mockFetch)
    ).rejects.toThrow('Sightengine API error: 429 Too Many Requests');
  });

  it('should handle network errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    await expect(
      moderateVideoWithSightengine('https://cdn.divine.video/test.mp4', {}, env, mockFetch)
    ).rejects.toThrow('Network timeout');
  });

  it('should require API credentials', async () => {
    const env = {};

    await expect(
      moderateVideoWithSightengine('https://cdn.divine.video/test.mp4', {}, env, fetch)
    ).rejects.toThrow('Sightengine API credentials not configured');
  });

  it('should include flagged frame positions', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }
            },
            {
              info: { position: 3 },
              nudity: { raw: 0.95, partial: 0.9, safe: 0.05 }  // Flagged
            },
            {
              info: { position: 6 },
              nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.flaggedFrames).toContainEqual(
      expect.objectContaining({ position: 3 })
    );
  });

  it('should request all moderation models including deepfake and detailed versions', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { frames: [] }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    const callUrl = mockFetch.mock.calls[0][0];
    expect(callUrl).toContain('nudity-2.1');
    expect(callUrl).toContain('offensive-2.0');
    expect(callUrl).toContain('gore-2.0');
    expect(callUrl).toContain('deepfake');
    expect(callUrl).toContain('genai');
    expect(callUrl).toContain('weapon');
    expect(callUrl).toContain('self-harm');
    expect(callUrl).toContain('text-content');
    expect(callUrl).toContain('qr-content');
  });

  it('should extract all category scores including new models', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: { raw: 0.1, sexual_activity: 0.05 },
              violence: { prob: 0.2, physical_violence: 0.15 },
              gore: { prob: 0.3, very_bloody: 0.25 },
              offensive: { prob: 0.4, nazi: 0.35 },
              weapon: { prob: 0.5, firearm: 0.45 },
              'self-harm': { prob: 0.6, real: 0.55 },
              type: { ai_generated: 0.7 },
              deepfake: { prob: 0.8 },
              recreational_drug: { prob: 0.1, cannabis: 0.05 },
              alcohol: { prob: 0.2 },
              tobacco: { prob: 0.3 },
              medical: { prob: 0.1 },
              gambling: { prob: 0.15 },
              money: { prob: 0.05 },
              destruction: { prob: 0.25 },
              military: { prob: 0.1 }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    // Verify all category scores are extracted
    expect(result.maxScores.nudity).toBe(0.1);
    expect(result.maxScores.sexual).toBe(0);
    expect(result.maxScores.porn).toBe(0.05);
    expect(result.maxScores.violence).toBe(0.2);
    expect(result.maxScores.gore).toBe(0.3);
    expect(result.maxScores.offensive).toBe(0.4);
    expect(result.maxScores.weapon).toBe(0.5);
    expect(result.maxScores.self_harm).toBe(0.6);
    expect(result.maxScores.ai_generated).toBe(0.7);
    expect(result.maxScores.deepfake).toBe(0.8);
    expect(result.maxScores.recreational_drug).toBe(0.1);
    expect(result.maxScores.alcohol).toBe(0.2);
    expect(result.maxScores.tobacco).toBe(0.3);
    expect(result.maxScores.medical).toBe(0.1);
    expect(result.maxScores.gambling).toBe(0.15);
    expect(result.maxScores.money).toBe(0.05);
    expect(result.maxScores.destruction).toBe(0.25);
    expect(result.maxScores.military).toBe(0.1);
  });

  it('should separate broad nudity from explicit sexual and porn signals', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: {
                male_underwear: 0.6,
                sexual_display: 0.81,
                sextoy: 0.7,
                sexual_activity: 0.93
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.maxScores.nudity).toBe(0.6);
    expect(result.maxScores.sexual).toBe(0.81);
    expect(result.maxScores.porn).toBe(0.93);
  });

  it('should extract detailed subcategories for nudity', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: {
                sexual_activity: 0.9,
                sexual_display: 0.8,
                erotica: 0.7,
                very_suggestive: 0.6,
                suggestive: 0.5,
                visibly_undressed: 0.4,
                sextoy: 0.3,
                lingerie: 0.2,
                male_underwear: 0.1
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.nudity.sexual_activity).toBe(0.9);
    expect(result.detailedCategories.nudity.sexual_display).toBe(0.8);
    expect(result.detailedCategories.nudity.erotica).toBe(0.7);
    expect(result.detailedCategories.nudity.sextoy).toBe(0.3);
    expect(result.detailedCategories.nudity.lingerie).toBe(0.2);
  });

  it('should extract detailed subcategories for gore', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              gore: {
                very_bloody: 0.9,
                slightly_bloody: 0.7,
                body_organ: 0.6,
                serious_injury: 0.5,
                corpse: 0.4,
                skull: 0.3,
                real: 0.8,
                fake: 0.2,
                animated: 0.1
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.gore.very_bloody).toBe(0.9);
    expect(result.detailedCategories.gore.corpse).toBe(0.4);
    expect(result.detailedCategories.gore.real).toBe(0.8);
    expect(result.detailedCategories.gore.fake).toBe(0.2);
  });

  it('should extract detailed subcategories for offensive/hate content', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              offensive: {
                nazi: 0.9,
                asian_swastika: 0.1,
                supremacist: 0.8,
                confederate: 0.7,
                terrorist: 0.6,
                middle_finger: 0.5
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.offensive.nazi).toBe(0.9);
    expect(result.detailedCategories.offensive.supremacist).toBe(0.8);
    expect(result.detailedCategories.offensive.terrorist).toBe(0.6);
    expect(result.detailedCategories.offensive.middle_finger).toBe(0.5);
  });

  it('should extract detailed subcategories for weapons', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              weapon: {
                firearm: 0.9,
                knife: 0.8,
                firearm_gesture: 0.7,
                firearm_toy: 0.6,
                aiming_threat: 0.5,
                aiming_camera: 0.4
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.weapon.firearm).toBe(0.9);
    expect(result.detailedCategories.weapon.knife).toBe(0.8);
    expect(result.detailedCategories.weapon.aiming_threat).toBe(0.5);
    expect(result.detailedCategories.weapon.firearm_toy).toBe(0.6);
  });

  it('should extract detailed subcategories for self-harm', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              'self-harm': {
                real: 0.9,
                fake: 0.3,
                animated: 0.1
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.self_harm.real).toBe(0.9);
    expect(result.detailedCategories.self_harm.fake).toBe(0.3);
    expect(result.detailedCategories.self_harm.animated).toBe(0.1);
  });

  it('should extract detailed subcategories for violence', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              violence: {
                physical_violence: 0.9,
                firearm_threat: 0.8,
                combat_sport: 0.3
              }
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.violence.physical_violence).toBe(0.9);
    expect(result.detailedCategories.violence.firearm_threat).toBe(0.8);
    expect(result.detailedCategories.violence.combat_sport).toBe(0.3);
  });

  it('should track maximum scores across multiple frames', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: { sexual_activity: 0.5 },
              gore: { very_bloody: 0.3 }
            },
            {
              info: { position: 3 },
              nudity: { sexual_activity: 0.9 },  // Max
              gore: { very_bloody: 0.7 }
            },
            {
              info: { position: 6 },
              nudity: { sexual_activity: 0.4 },
              gore: { very_bloody: 0.95 }  // Max
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    expect(result.detailedCategories.nudity.sexual_activity).toBe(0.9);
    expect(result.detailedCategories.gore.very_bloody).toBe(0.95);
  });

  it('should include detailed subcategories in flagged frames', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            {
              info: { position: 0 },
              nudity: { sexual_activity: 0.1 },
              offensive: { nazi: 0.05 }
            },
            {
              info: { position: 3 },
              nudity: { sexual_activity: 0.95 },  // Flagged
              offensive: { nazi: 0.9 }  // Also flagged
            }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    const result = await moderateVideoWithSightengine(
      'https://cdn.divine.video/test.mp4',
      {},
      env,
      mockFetch
    );

    const flaggedFrame = result.flaggedFrames.find(f => f.position === 3);
    expect(flaggedFrame).toBeDefined();
    expect(flaggedFrame.details.nudity.sexual_activity).toBe(0.95);
    expect(flaggedFrame.details.offensive.nazi).toBe(0.9);
    expect(flaggedFrame.primaryConcern).toBeDefined();
    expect(flaggedFrame.primaryScore).toBeGreaterThanOrEqual(0.9);
  });
});
