// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the classification pipeline
// ABOUTME: Validates end-to-end VLM classification flow and output formatters

import { describe, it, expect, vi } from 'vitest';
import { classifyVideo, formatForStorage, formatForGorse, formatForFunnelcake } from './pipeline.mjs';

/** Build a mock Hive VLM chat completion API response. */
function mockVLMResponse(content = {}) {
  return {
    id: 'task_123',
    object: 'chat.completion',
    model: 'hive/vision-language-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify({
          topics: ['sports', 'travel'],
          setting: 'beach outdoor',
          objects: ['surfboard', 'person'],
          activities: ['surfing', 'swimming'],
          mood: 'exciting',
          description: 'People surfing and swimming at a beautiful beach.',
          ...content
        })
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 1818, completion_tokens: 64, total_tokens: 1882 }
  };
}

describe('classifyVideo', () => {
  it('should return skipped result when HIVE_VLM_API_KEY not set', async () => {
    const result = await classifyVideo('https://media.divine.video/test.mp4', {});
    expect(result.skipped).toBe(true);
    expect(result.labels).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.description).toBe('');
    expect(result.provider).toBeNull();
  });

  it('should skip Hive VLM unless explicitly enabled', async () => {
    const mockFetch = vi.fn();

    const result = await classifyVideo(
      'https://media.divine.video/test.mp4',
      { HIVE_VLM_API_KEY: 'vlm-key' },
      { sha256: 'abc123', fetchFn: mockFetch }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('Hive VLM classification disabled');
    expect(result.provider).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should classify video and return labels', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockVLMResponse()
    });

    const env = { HIVE_VLM_API_KEY: 'vlm-key', HIVE_VLM_ENABLED: 'true' };
    const result = await classifyVideo(
      'https://media.divine.video/test.mp4',
      env,
      { sha256: 'abc123', fetchFn: mockFetch }
    );

    expect(result.skipped).toBe(false);
    expect(result.sha256).toBe('abc123');
    expect(result.provider).toBe('hiveai-vlm');
    expect(result.labels.length).toBeGreaterThan(0);
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topCategories.length).toBeGreaterThan(0);

    // Verify the labels contain expected items
    const labelNames = result.labels.map(l => l.label);
    expect(labelNames).toContain('sports');
    expect(labelNames).toContain('travel');
    expect(labelNames).toContain('beach-outdoor');
    expect(labelNames).toContain('surfboard');
    expect(labelNames).toContain('person');
  });

  it('should include description in result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockVLMResponse()
    });

    const env = { HIVE_VLM_API_KEY: 'vlm-key', HIVE_VLM_ENABLED: 'true' };
    const result = await classifyVideo(
      'https://media.divine.video/test.mp4',
      env,
      { sha256: 'abc123', fetchFn: mockFetch }
    );

    expect(result.description).toBe('People surfing and swimming at a beautiful beach.');
  });

  it('should include activities and mood', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockVLMResponse()
    });

    const env = { HIVE_VLM_API_KEY: 'vlm-key', HIVE_VLM_ENABLED: 'true' };
    const result = await classifyVideo(
      'https://media.divine.video/test.mp4',
      env,
      { sha256: 'abc123', fetchFn: mockFetch }
    );

    expect(result.activities).toEqual(['surfing', 'swimming']);
    expect(result.mood).toBe('exciting');
  });

  it('should propagate API errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    const env = { HIVE_VLM_API_KEY: 'vlm-key', HIVE_VLM_ENABLED: 'true' };

    await expect(
      classifyVideo('https://media.divine.video/test.mp4', env, { fetchFn: mockFetch })
    ).rejects.toThrow('Hive VLM classification failed');
  });

  it('should handle malformed VLM JSON gracefully', async () => {
    const badResponse = {
      id: 'task_bad',
      object: 'chat.completion',
      model: 'hive/vision-language-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'not valid json at all'
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => badResponse
    });

    const env = { HIVE_VLM_API_KEY: 'vlm-key', HIVE_VLM_ENABLED: 'true' };
    const result = await classifyVideo(
      'https://media.divine.video/test.mp4',
      env,
      { sha256: 'abc123', fetchFn: mockFetch }
    );

    // Should not throw, just return empty data
    expect(result.skipped).toBe(false);
    expect(result.topics).toEqual([]);
    expect(result.labels).toEqual([]);
    expect(result.description).toBe('');
  });
});

describe('formatForStorage', () => {
  it('should return null for skipped result', () => {
    expect(formatForStorage({ skipped: true })).toBeNull();
    expect(formatForStorage(null)).toBeNull();
  });

  it('should strip raw data but keep description', () => {
    const result = {
      provider: 'hiveai-vlm',
      sha256: 'abc123',
      processingTime: 1500,
      labels: [{ label: 'sports', namespace: 'topic', score: 1.0 }],
      topics: ['sports'],
      setting: 'beach',
      objects: ['surfboard'],
      activities: ['surfing'],
      mood: 'exciting',
      description: 'Surfing at the beach.',
      topCategories: [{ category: 'sports', score: 1.0 }],
      topSettings: [{ setting: 'beach', score: 1.0 }],
      topObjects: [{ object: 'surfboard', score: 1.0 }],
      classesDetected: 4,
      extractedAt: '2025-01-01T00:00:00.000Z',
      raw: { big: 'object' },
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    };

    const stored = formatForStorage(result);
    expect(stored.raw).toBeUndefined();
    expect(stored.usage).toBeUndefined();
    expect(stored.provider).toBe('hiveai-vlm');
    expect(stored.labels).toHaveLength(1);
    expect(stored.description).toBe('Surfing at the beach.');
    expect(stored.topics).toEqual(['sports']);
    expect(stored.setting).toBe('beach');
    expect(stored.activities).toEqual(['surfing']);
    expect(stored.mood).toBe('exciting');
  });
});

describe('formatForGorse', () => {
  it('should return empty array for skipped result', () => {
    expect(formatForGorse({ skipped: true })).toEqual([]);
    expect(formatForGorse(null)).toEqual([]);
  });

  it('should return namespaced label strings', () => {
    const result = {
      labels: [
        { label: 'sports', namespace: 'topic', score: 1.0 },
        { label: 'beach-outdoor', namespace: 'setting', score: 1.0 },
        { label: 'surfboard', namespace: 'object', score: 1.0 },
        { label: 'surfing', namespace: 'activity', score: 1.0 },
        { label: 'exciting', namespace: 'mood', score: 1.0 }
      ]
    };

    const gorseLabels = formatForGorse(result);
    expect(gorseLabels).toEqual([
      'topic:sports',
      'setting:beach-outdoor',
      'object:surfboard',
      'activity:surfing',
      'mood:exciting'
    ]);
  });
});

describe('formatForFunnelcake', () => {
  it('should return empty object for skipped result', () => {
    expect(formatForFunnelcake({ skipped: true })).toEqual({});
    expect(formatForFunnelcake(null)).toEqual({});
  });

  it('should return topic-weight map', () => {
    const result = {
      labels: [
        { label: 'sports', namespace: 'topic', score: 1.0 },
        { label: 'beach-outdoor', namespace: 'setting', score: 1.0 }
      ]
    };

    const topics = formatForFunnelcake(result);
    expect(topics).toEqual({
      'topic:sports': 1.0,
      'setting:beach-outdoor': 1.0
    });
  });
});
