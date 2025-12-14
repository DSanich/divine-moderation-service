// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Hive.AI API client with dual model support
// ABOUTME: Tests content moderation and AI detection API calls

import { describe, it, expect, vi } from 'vitest';
import {
  moderateWithHiveModeration,
  moderateWithHiveAIDetection,
  moderateVideoWithHiveAI
} from './client.mjs';

describe('Hive.AI Client', () => {
  describe('moderateWithHiveModeration', () => {
    it('should call moderation API with correct auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: [{ response: { output: [] } }] })
      });

      const env = { HIVE_MODERATION_API_KEY: 'mod-key-123' };

      await moderateWithHiveModeration(
        'https://cdn.divine.video/test.mp4',
        env,
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.thehive.ai/api/v2/task/sync',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'authorization': 'token mod-key-123'
          })
        })
      );
    });

    it('should throw if HIVE_MODERATION_API_KEY not configured', async () => {
      await expect(
        moderateWithHiveModeration('https://cdn.divine.video/test.mp4', {}, {})
      ).rejects.toThrow('HIVE_MODERATION_API_KEY not configured');
    });
  });

  describe('moderateWithHiveAIDetection', () => {
    it('should call AI detection API with correct auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: [{ response: { output: [] } }] })
      });

      const env = { HIVE_AI_DETECTION_API_KEY: 'ai-key-456' };

      await moderateWithHiveAIDetection(
        'https://cdn.divine.video/test.mp4',
        env,
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.thehive.ai/api/v2/task/sync',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'authorization': 'token ai-key-456'
          })
        })
      );
    });

    it('should throw if HIVE_AI_DETECTION_API_KEY not configured', async () => {
      await expect(
        moderateWithHiveAIDetection('https://cdn.divine.video/test.mp4', {}, {})
      ).rejects.toThrow('HIVE_AI_DETECTION_API_KEY not configured');
    });
  });

  describe('moderateVideoWithHiveAI (combined)', () => {
    it('should call both APIs when both keys present', async () => {
      const calls = [];
      const mockFetch = vi.fn().mockImplementation((url, options) => {
        calls.push(options.headers.authorization);
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: [{ response: { output: [] } }] })
        });
      });

      const env = {
        HIVE_MODERATION_API_KEY: 'mod-key',
        HIVE_AI_DETECTION_API_KEY: 'ai-key'
      };

      const result = await moderateVideoWithHiveAI(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        env,
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(calls).toContain('token mod-key');
      expect(calls).toContain('token ai-key');
      expect(result.moderation).toBeDefined();
      expect(result.aiDetection).toBeDefined();
    });

    it('should work with only moderation key', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: [{ response: { output: [] } }] })
      });

      const env = { HIVE_MODERATION_API_KEY: 'mod-key' };

      const result = await moderateVideoWithHiveAI(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        env,
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.moderation).toBeDefined();
      expect(result.aiDetection).toBeNull();
    });

    it('should work with only AI detection key', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: [{ response: { output: [] } }] })
      });

      const env = { HIVE_AI_DETECTION_API_KEY: 'ai-key' };

      const result = await moderateVideoWithHiveAI(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        env,
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.moderation).toBeNull();
      expect(result.aiDetection).toBeDefined();
    });

    it('should throw if no API keys configured', async () => {
      await expect(
        moderateVideoWithHiveAI(
          'https://cdn.divine.video/test.mp4',
          { sha256: 'test' },
          {},
          {}
        )
      ).rejects.toThrow('No Hive.AI API keys configured');
    });

    it('should handle partial failures gracefully', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call succeeds
          return Promise.resolve({
            ok: true,
            json: async () => ({ status: [{ response: { output: [] } }] })
          });
        } else {
          // Second call fails
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => 'API Error'
          });
        }
      });

      const env = {
        HIVE_MODERATION_API_KEY: 'mod-key',
        HIVE_AI_DETECTION_API_KEY: 'ai-key'
      };

      const result = await moderateVideoWithHiveAI(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        env,
        { fetchFn: mockFetch }
      );

      // Should succeed with partial results
      expect(result.errors.length).toBe(1);
    });
  });
});
