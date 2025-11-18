// ABOUTME: Integration tests for Hive.AI provider adapter
// ABOUTME: Verifies end-to-end moderation flow with V3 API

import { describe, it, expect, vi } from 'vitest';
import { HiveAIProvider } from './adapter.mjs';

describe('HiveAI Provider Adapter', () => {
  const mockEnv = {
    HIVE_API_KEY: 'test-api-key'
  };

  it('should report correct capabilities', () => {
    const provider = new HiveAIProvider();

    expect(provider.name).toBe('hiveai');
    expect(provider.capabilities.ai_generated).toBe(true);
    expect(provider.capabilities.deepfake).toBe(true);
    expect(provider.capabilities.nudity).toBe(false); // Not supported by AI-detection model
    expect(provider.capabilities.violence).toBe(false);
  });

  it('should check if configured with both credentials', () => {
    const provider = new HiveAIProvider();

    expect(provider.isConfigured(mockEnv)).toBe(true);
    expect(provider.isConfigured({ HIVE_API_ACCESS_KEY: 'key-only' })).toBe(false);
    expect(provider.isConfigured({ HIVE_API_SECRET: 'secret-only' })).toBe(false);
    expect(provider.isConfigured({})).toBe(false);
  });

  it('should moderate video and return normalized result', async () => {
    const provider = new HiveAIProvider();

    const mockApiResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'ai_generated', score: 0.95 },
                { class: 'midjourney', score: 0.88 }
              ]
            },
            {
              time: 3,
              classes: [
                { class: 'ai_generated', score: 0.92 },
                { class: 'stable_diffusion', score: 0.80 }
              ]
            }
          ]
        }
      }]
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse
    });

    const result = await provider.moderate(
      'https://cdn.divine.video/test123.mp4',
      { sha256: 'test123' },
      mockEnv,
      { fetchFn: mockFetch }
    );

    // Verify provider metadata
    expect(result.provider).toBe('hiveai');
    expect(result.processingTime).toBeGreaterThan(0);

    // Verify normalized scores
    expect(result.scores.ai_generated).toBe(0.95);
    expect(result.scores.nudity).toBe(0); // Not detected by this model
    expect(result.scores.violence).toBe(0);

    // Verify details
    expect(result.details.ai_generated.totalFrames).toBe(2);
    expect(result.details.ai_generated.framesDetected).toBe(2);
    expect(result.details.ai_generated.detectedSource).toBe('midjourney');

    // Verify raw response is included
    expect(result.raw).toEqual(mockApiResponse);

    // Verify flagged frames
    expect(result.flaggedFrames).toHaveLength(2);
  });

  it('should throw error when API fails', async () => {
    const provider = new HiveAIProvider();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    });

    await expect(
      provider.moderate(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        mockEnv,
        { fetchFn: mockFetch }
      )
    ).rejects.toThrow('Hive.AI moderation failed');
  });

  it('should handle video with no AI-generated content', async () => {
    const provider = new HiveAIProvider();

    const mockApiResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'not_ai_generated', score: 0.98 },
                { class: 'none', score: 0.95 }
              ]
            },
            {
              time: 3,
              classes: [
                { class: 'not_ai_generated', score: 0.97 },
                { class: 'none', score: 0.93 }
              ]
            }
          ]
        }
      }]
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse
    });

    const result = await provider.moderate(
      'https://cdn.divine.video/test123.mp4',
      { sha256: 'test123' },
      mockEnv,
      { fetchFn: mockFetch }
    );

    expect(result.scores.ai_generated).toBeLessThan(0.1);
    expect(result.details.ai_generated.framesDetected).toBe(0);
    expect(result.details.ai_generated.detectedSource).toBeNull();
    expect(result.flaggedFrames).toHaveLength(0);
  });

  it('should detect deepfakes separately from AI-generated', async () => {
    const provider = new HiveAIProvider();

    const mockApiResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'ai_generated', score: 0.3 },
                { class: 'deepfake', score: 0.7 }
              ]
            },
            {
              time: 1,
              classes: [
                { class: 'ai_generated', score: 0.2 },
                { class: 'deepfake', score: 0.8 }
              ]
            }
          ]
        }
      }]
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse
    });

    const result = await provider.moderate(
      'https://cdn.divine.video/test123.mp4',
      { sha256: 'test123' },
      mockEnv,
      { fetchFn: mockFetch }
    );

    // AI-generated score is low
    expect(result.scores.ai_generated).toBeLessThan(0.9);

    // But deepfake score is high
    expect(result.scores.deepfake).toBe(0.8);
    expect(result.details.deepfake.consecutiveFrames).toBe(2);
    expect(result.details.deepfake.framesDetected).toBe(2);
  });
});
