// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Hive VLM (Vision Language Model) classification API client
// ABOUTME: Validates request format, auth headers, JSON body, and error handling

import { describe, it, expect, vi } from 'vitest';
import {
  callVLMClassificationAPI,
  classifyWithHiveVLM
} from './client.mjs';

/** Build a mock VLM response matching the chat/completions format. */
function mockVLMResponse(content = {}) {
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

describe('Hive VLM Classification Client', () => {
  describe('callVLMClassificationAPI', () => {
    it('should call the V3 chat/completions endpoint with Bearer auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockVLMResponse({ topics: ['music'] })
      });

      await callVLMClassificationAPI(
        'https://media.divine.video/test.mp4',
        'vlm-key-123',
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.thehive.ai/api/v3/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer vlm-key-123',
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should send JSON body with correct model and video URL', async () => {
      let capturedBody = null;
      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: async () => mockVLMResponse({ topics: [] })
        });
      });

      await callVLMClassificationAPI(
        'https://media.divine.video/test.mp4',
        'key',
        { fetchFn: mockFetch }
      );

      expect(capturedBody.model).toBe('hive/vision-language-model');
      expect(capturedBody.max_tokens).toBe(512);
      expect(capturedBody.response_format.type).toBe('json_schema');
      expect(capturedBody.response_format.json_schema.name).toBe('video_classification');

      // Check the messages contain both video and text
      const messages = capturedBody.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toHaveLength(2);

      const mediaContent = messages[0].content[0];
      expect(mediaContent.type).toBe('media_url');
      expect(mediaContent.media_url.url).toBe('https://media.divine.video/test.mp4');
      expect(mediaContent.media_url.sampling.strategy).toBe('fps');
      expect(mediaContent.media_url.sampling.fps).toBe(1);
      expect(mediaContent.media_url.prompt_scope).toBe('once');

      const textContent = messages[0].content[1];
      expect(textContent.type).toBe('text');
      expect(textContent.text).toContain('Classify this short video');
    });

    it('should allow custom prompt', async () => {
      let capturedBody = null;
      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: async () => mockVLMResponse({ topics: [] })
        });
      });

      await callVLMClassificationAPI(
        'https://media.divine.video/test.mp4',
        'key',
        { fetchFn: mockFetch, prompt: 'Custom prompt here' }
      );

      const textContent = capturedBody.messages[0].content[1];
      expect(textContent.text).toBe('Custom prompt here');
    });

    it('should allow custom fps and maxTokens', async () => {
      let capturedBody = null;
      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: async () => mockVLMResponse({ topics: [] })
        });
      });

      await callVLMClassificationAPI(
        'https://media.divine.video/test.mp4',
        'key',
        { fetchFn: mockFetch, fps: 2, maxTokens: 256 }
      );

      expect(capturedBody.max_tokens).toBe(256);
      expect(capturedBody.messages[0].content[0].media_url.sampling.fps).toBe(2);
    });

    it('should throw on non-OK response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      });

      await expect(
        callVLMClassificationAPI('https://media.divine.video/test.mp4', 'bad-key', { fetchFn: mockFetch })
      ).rejects.toThrow('Hive VLM API error: 401 Unauthorized');
    });

    it('should throw on server error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      });

      await expect(
        callVLMClassificationAPI('https://media.divine.video/test.mp4', 'key', { fetchFn: mockFetch })
      ).rejects.toThrow('Hive VLM API error: 500');
    });
  });

  describe('classifyWithHiveVLM', () => {
    it('should throw if HIVE_VLM_API_KEY not configured', async () => {
      await expect(
        classifyWithHiveVLM('https://media.divine.video/test.mp4', {}, {})
      ).rejects.toThrow('HIVE_VLM_API_KEY not configured');
    });

    it('should call API with VLM key from env', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockVLMResponse({ topics: ['music'] })
      });

      const env = { HIVE_VLM_API_KEY: 'vlm-key-789' };

      await classifyWithHiveVLM(
        'https://media.divine.video/test.mp4',
        env,
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.thehive.ai/api/v3/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer vlm-key-789'
          })
        })
      );
    });

    it('should use custom prompt from HIVE_VLM_PROMPT env var', async () => {
      let capturedBody = null;
      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: async () => mockVLMResponse({ topics: [] })
        });
      });

      const env = {
        HIVE_VLM_API_KEY: 'vlm-key',
        HIVE_VLM_PROMPT: 'Describe this video in detail.'
      };

      await classifyWithHiveVLM(
        'https://media.divine.video/test.mp4',
        env,
        { fetchFn: mockFetch }
      );

      const textContent = capturedBody.messages[0].content[1];
      expect(textContent.text).toBe('Describe this video in detail.');
    });

    it('should return raw API response', async () => {
      const vlmResponse = mockVLMResponse({
        topics: ['music', 'dance'],
        setting: 'indoor studio',
        objects: ['microphone', 'speakers'],
        activities: ['dancing', 'singing'],
        mood: 'energetic',
        description: 'A person dances energetically in a studio.'
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => vlmResponse
      });

      const env = { HIVE_VLM_API_KEY: 'vlm-key' };
      const result = await classifyWithHiveVLM(
        'https://media.divine.video/test.mp4',
        env,
        { fetchFn: mockFetch }
      );

      expect(result).toEqual(vlmResponse);
    });
  });
});
