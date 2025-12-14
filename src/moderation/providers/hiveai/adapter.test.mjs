// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Integration tests for Hive.AI provider adapter
// ABOUTME: Verifies end-to-end moderation flow with dual API support

import { describe, it, expect, vi } from 'vitest';
import { HiveAIProvider } from './adapter.mjs';

describe('HiveAI Provider Adapter', () => {
  const mockEnvFull = {
    HIVE_MODERATION_API_KEY: 'mod-key',
    HIVE_AI_DETECTION_API_KEY: 'ai-key'
  };

  const mockEnvModerationOnly = {
    HIVE_MODERATION_API_KEY: 'mod-key'
  };

  const mockEnvAIOnly = {
    HIVE_AI_DETECTION_API_KEY: 'ai-key'
  };

  describe('capabilities', () => {
    it('should report full capabilities when both keys present', () => {
      const provider = new HiveAIProvider();

      expect(provider.name).toBe('hiveai');
      expect(provider.capabilities.ai_generated).toBe(true);
      expect(provider.capabilities.deepfake).toBe(true);
      expect(provider.capabilities.nudity).toBe(true);
      expect(provider.capabilities.violence).toBe(true);
      expect(provider.capabilities.weapons).toBe(true);
    });

    it('should report available capabilities based on configured keys', () => {
      const provider = new HiveAIProvider();

      const fullCaps = provider.getAvailableCapabilities(mockEnvFull);
      expect(fullCaps.nudity).toBe(true);
      expect(fullCaps.ai_generated).toBe(true);

      const modOnlyCaps = provider.getAvailableCapabilities(mockEnvModerationOnly);
      expect(modOnlyCaps.nudity).toBe(true);
      expect(modOnlyCaps.ai_generated).toBe(false);

      const aiOnlyCaps = provider.getAvailableCapabilities(mockEnvAIOnly);
      expect(aiOnlyCaps.nudity).toBe(false);
      expect(aiOnlyCaps.ai_generated).toBe(true);
    });
  });

  describe('isConfigured', () => {
    it('should be configured with moderation key only', () => {
      const provider = new HiveAIProvider();
      expect(provider.isConfigured(mockEnvModerationOnly)).toBe(true);
    });

    it('should be configured with AI detection key only', () => {
      const provider = new HiveAIProvider();
      expect(provider.isConfigured(mockEnvAIOnly)).toBe(true);
    });

    it('should be configured with both keys', () => {
      const provider = new HiveAIProvider();
      expect(provider.isConfigured(mockEnvFull)).toBe(true);
    });

    it('should not be configured with no keys', () => {
      const provider = new HiveAIProvider();
      expect(provider.isConfigured({})).toBe(false);
    });
  });

  describe('moderation with both APIs', () => {
    it('should call both APIs and merge results', async () => {
      const provider = new HiveAIProvider();

      const calls = [];
      const mockFetch = vi.fn().mockImplementation((url, options) => {
        const key = options.headers.authorization;
        calls.push(key);

        // Return different responses based on which API is being called
        if (key === 'token mod-key') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              status: [{
                response: {
                  output: [{
                    time: 0,
                    classes: [{ class: 'yes_female_nudity', score: 0.85 }]
                  }]
                }
              }]
            })
          });
        } else {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              status: [{
                response: {
                  output: [{
                    time: 0,
                    classes: [
                      { class: 'ai_generated', score: 0.95 },
                      { class: 'midjourney', score: 0.88 }
                    ]
                  }]
                }
              }]
            })
          });
        }
      });

      const result = await provider.moderate(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        mockEnvFull,
        { fetchFn: mockFetch }
      );

      // Both APIs should be called
      expect(calls).toContain('token mod-key');
      expect(calls).toContain('token ai-key');

      // Results should be merged
      expect(result.scores.nudity).toBe(0.85);
      expect(result.scores.ai_generated).toBe(0.95);
      expect(result.details.ai_generated.detectedSource).toBe('midjourney');
      expect(result.provider).toBe('hiveai');
    });
  });

  describe('moderation with moderation API only', () => {
    it('should return content moderation scores', async () => {
      const provider = new HiveAIProvider();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: [{
            response: {
              output: [{
                time: 0,
                classes: [
                  { class: 'yes_violence', score: 0.75 },
                  { class: 'yes_blood_shed', score: 0.6 }
                ]
              }]
            }
          }]
        })
      });

      const result = await provider.moderate(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        mockEnvModerationOnly,
        { fetchFn: mockFetch }
      );

      expect(result.scores.violence).toBe(0.75);
      expect(result.scores.gore).toBe(0.6);
      expect(result.scores.ai_generated).toBe(0);
    });
  });

  describe('moderation with AI detection API only', () => {
    it('should return AI detection scores', async () => {
      const provider = new HiveAIProvider();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: [{
            response: {
              output: [
                { time: 0, classes: [{ class: 'deepfake', score: 0.7 }] },
                { time: 1, classes: [{ class: 'deepfake', score: 0.8 }] }
              ]
            }
          }]
        })
      });

      const result = await provider.moderate(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        mockEnvAIOnly,
        { fetchFn: mockFetch }
      );

      expect(result.scores.deepfake).toBe(0.8);
      expect(result.details.deepfake.consecutiveFrames).toBe(2);
      expect(result.scores.nudity).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw error when all APIs fail', async () => {
      const provider = new HiveAIProvider();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server Error'
      });

      await expect(
        provider.moderate(
          'https://cdn.divine.video/test.mp4',
          { sha256: 'test' },
          mockEnvFull,
          { fetchFn: mockFetch }
        )
      ).rejects.toThrow('Hive.AI moderation failed');
    });

    it('should succeed with partial results if one API fails', async () => {
      const provider = new HiveAIProvider();

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call succeeds
          return Promise.resolve({
            ok: true,
            json: async () => ({
              status: [{
                response: {
                  output: [{
                    time: 0,
                    classes: [{ class: 'yes_violence', score: 0.8 }]
                  }]
                }
              }]
            })
          });
        } else {
          // Second call fails
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => 'Error'
          });
        }
      });

      const result = await provider.moderate(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        mockEnvFull,
        { fetchFn: mockFetch }
      );

      // Should still return results from successful API
      expect(result.scores).toBeDefined();
      expect(result.raw.errors.length).toBe(1);
    });
  });
});
