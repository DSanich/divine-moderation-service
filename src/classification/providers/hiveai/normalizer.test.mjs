// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Hive VLM classification normalizer
// ABOUTME: Validates JSON parsing, topic extraction, label generation, and error handling

import { describe, it, expect } from 'vitest';
import {
  parseVLMContent,
  normalizeVLMResponse,
  toRecommendationLabels,
  KNOWN_TOPICS
} from './normalizer.mjs';

/** Build a mock VLM chat completion response. */
function mockVLMResponse(content) {
  return {
    id: 'task_123',
    object: 'chat.completion',
    model: 'hive/vision-language-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify(content)
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 1818, completion_tokens: 64, total_tokens: 1882 }
  };
}

describe('parseVLMContent', () => {
  it('should parse valid JSON content from VLM response', () => {
    const response = mockVLMResponse({
      topics: ['music', 'dance'],
      setting: 'indoor studio',
      objects: ['microphone', 'speakers'],
      activities: ['dancing', 'singing'],
      mood: 'energetic',
      description: 'A person dances energetically in a studio.'
    });

    const result = parseVLMContent(response);

    expect(result.topics).toEqual(['music', 'dance']);
    expect(result.setting).toBe('indoor-studio');
    expect(result.objects).toEqual(['microphone', 'speakers']);
    expect(result.activities).toEqual(['dancing', 'singing']);
    expect(result.mood).toBe('energetic');
    expect(result.description).toBe('A person dances energetically in a studio.');
  });

  it('should return empty result for missing choices', () => {
    const result = parseVLMContent({});
    expect(result.topics).toEqual([]);
    expect(result.setting).toBe('');
    expect(result.objects).toEqual([]);
    expect(result.activities).toEqual([]);
    expect(result.mood).toBe('');
    expect(result.description).toBe('');
  });

  it('should return empty result for null response', () => {
    const result = parseVLMContent(null);
    expect(result.topics).toEqual([]);
  });

  it('should handle malformed JSON content gracefully', () => {
    const response = {
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'this is not valid json {{{{'
        }
      }]
    };

    const result = parseVLMContent(response);
    expect(result.topics).toEqual([]);
    expect(result.description).toBe('');
  });

  it('should normalise topics to lower-case hyphenated strings', () => {
    const response = mockVLMResponse({
      topics: ['Music', 'Food And Drink', ' Travel '],
      setting: 'Urban Outdoor',
      objects: ['Motor Vehicle'],
      activities: ['Street Performance'],
      mood: 'Upbeat',
      description: 'Test'
    });

    const result = parseVLMContent(response);

    expect(result.topics).toEqual(['music', 'food-and-drink', 'travel']);
    expect(result.setting).toBe('urban-outdoor');
    expect(result.objects).toEqual(['motor-vehicle']);
    expect(result.activities).toEqual(['street-performance']);
    expect(result.mood).toBe('upbeat');
  });

  it('should filter out empty strings from arrays', () => {
    const response = mockVLMResponse({
      topics: ['music', '', '  ', 'dance'],
      setting: '',
      objects: ['', 'guitar'],
      activities: [],
      mood: '',
      description: ''
    });

    const result = parseVLMContent(response);
    expect(result.topics).toEqual(['music', 'dance']);
    expect(result.objects).toEqual(['guitar']);
    expect(result.setting).toBe('');
  });

  it('should handle non-array topics gracefully', () => {
    const response = mockVLMResponse({
      topics: 'music',
      setting: 123,
      objects: null,
      activities: undefined,
      mood: true,
      description: 42
    });

    const result = parseVLMContent(response);
    expect(result.topics).toEqual([]);
    expect(result.setting).toBe('');
    expect(result.objects).toEqual([]);
    expect(result.activities).toEqual([]);
    expect(result.mood).toBe('');
    expect(result.description).toBe('');
  });
});

describe('normalizeVLMResponse', () => {
  it('should produce topCategories, topSettings, topObjects from VLM data', () => {
    const response = mockVLMResponse({
      topics: ['music', 'dance'],
      setting: 'indoor studio',
      objects: ['microphone', 'speakers'],
      activities: ['dancing', 'singing'],
      mood: 'energetic',
      description: 'A person dances.'
    });

    const result = normalizeVLMResponse(response);

    expect(result.topCategories).toEqual([
      { category: 'music', score: 1.0 },
      { category: 'dance', score: 1.0 }
    ]);
    expect(result.topSettings).toEqual([
      { setting: 'indoor-studio', score: 1.0 }
    ]);
    expect(result.topObjects).toEqual([
      { object: 'microphone', score: 1.0 },
      { object: 'speakers', score: 1.0 }
    ]);
  });

  it('should include description in the result', () => {
    const response = mockVLMResponse({
      topics: ['sports'],
      setting: 'beach',
      objects: ['surfboard'],
      activities: ['surfing'],
      mood: 'exciting',
      description: 'A surfer rides a wave on a sunny beach.'
    });

    const result = normalizeVLMResponse(response);
    expect(result.description).toBe('A surfer rides a wave on a sunny beach.');
  });

  it('should include usage data for cost tracking', () => {
    const response = mockVLMResponse({
      topics: ['sports'],
      setting: 'gym',
      objects: [],
      activities: ['exercising'],
      mood: 'motivated',
      description: 'Working out.'
    });

    const result = normalizeVLMResponse(response);
    expect(result.usage).toEqual({
      prompt_tokens: 1818,
      completion_tokens: 64,
      total_tokens: 1882
    });
  });

  it('should count classesDetected correctly', () => {
    const response = mockVLMResponse({
      topics: ['music', 'dance'],
      setting: 'studio',
      objects: ['guitar', 'microphone'],
      activities: ['playing', 'singing'],
      mood: 'fun',
      description: 'Music.'
    });

    const result = normalizeVLMResponse(response);
    // 2 topics + 1 setting + 2 objects + 2 activities = 7
    expect(result.classesDetected).toBe(7);
  });

  it('should handle empty VLM response', () => {
    const result = normalizeVLMResponse({});
    expect(result.topics).toEqual([]);
    expect(result.topCategories).toEqual([]);
    expect(result.description).toBe('');
    expect(result.classesDetected).toBe(0);
  });

  it('should have extractedAt timestamp', () => {
    const response = mockVLMResponse({
      topics: [],
      setting: '',
      objects: [],
      activities: [],
      mood: '',
      description: ''
    });

    const result = normalizeVLMResponse(response);
    expect(result.extractedAt).toBeDefined();
    // Should be a valid ISO date
    expect(new Date(result.extractedAt).toISOString()).toBe(result.extractedAt);
  });
});

describe('toRecommendationLabels', () => {
  it('should generate namespaced labels from VLM classification result', () => {
    const classificationResult = {
      topics: ['music', 'dance'],
      setting: 'indoor-studio',
      objects: ['microphone'],
      activities: ['dancing'],
      mood: 'energetic'
    };

    const labels = toRecommendationLabels(classificationResult);

    expect(labels).toHaveLength(6);
    expect(labels).toContainEqual({ label: 'music', namespace: 'topic', score: 1.0 });
    expect(labels).toContainEqual({ label: 'dance', namespace: 'topic', score: 1.0 });
    expect(labels).toContainEqual({ label: 'indoor-studio', namespace: 'setting', score: 1.0 });
    expect(labels).toContainEqual({ label: 'microphone', namespace: 'object', score: 1.0 });
    expect(labels).toContainEqual({ label: 'dancing', namespace: 'activity', score: 1.0 });
    expect(labels).toContainEqual({ label: 'energetic', namespace: 'mood', score: 1.0 });
  });

  it('should respect maxLabels option', () => {
    const classificationResult = {
      topics: ['a', 'b', 'c', 'd', 'e'],
      setting: 'test',
      objects: ['x', 'y'],
      activities: ['z'],
      mood: 'happy'
    };

    const labels = toRecommendationLabels(classificationResult, { maxLabels: 3 });
    expect(labels).toHaveLength(3);
  });

  it('should skip empty setting and mood', () => {
    const classificationResult = {
      topics: ['music'],
      setting: '',
      objects: [],
      activities: [],
      mood: ''
    };

    const labels = toRecommendationLabels(classificationResult);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toEqual({ label: 'music', namespace: 'topic', score: 1.0 });
  });

  it('should return empty array for empty classification', () => {
    const labels = toRecommendationLabels({
      topics: [],
      setting: '',
      objects: [],
      activities: [],
      mood: ''
    });
    expect(labels).toEqual([]);
  });

  it('should return empty array for null/undefined input', () => {
    expect(toRecommendationLabels(null)).toEqual([]);
    expect(toRecommendationLabels(undefined)).toEqual([]);
  });
});

describe('KNOWN_TOPICS', () => {
  it('should contain common content categories', () => {
    expect(KNOWN_TOPICS.has('music')).toBe(true);
    expect(KNOWN_TOPICS.has('comedy')).toBe(true);
    expect(KNOWN_TOPICS.has('sports')).toBe(true);
    expect(KNOWN_TOPICS.has('food')).toBe(true);
    expect(KNOWN_TOPICS.has('travel')).toBe(true);
    expect(KNOWN_TOPICS.has('gaming')).toBe(true);
    expect(KNOWN_TOPICS.has('education')).toBe(true);
  });
});
