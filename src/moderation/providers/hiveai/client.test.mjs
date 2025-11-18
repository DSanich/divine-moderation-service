// ABOUTME: Tests for Hive.AI V3 API client
// ABOUTME: Verifies AI-generated content detection API calls and authentication

import { describe, it, expect, vi } from 'vitest';
import { moderateVideoWithHiveAI } from './client.mjs';

describe('Hive.AI V2 Client', () => {
  const mockEnv = {
    HIVE_API_KEY: 'test-api-key'
  };

  it('should call Hive.AI V2 API with token authentication', async () => {
    const mockResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'ai_generated', score: 0.95 },
                { class: 'midjourney', score: 0.88 }
              ]
            }
          ]
        }
      }]
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    });

    const result = await moderateVideoWithHiveAI(
      'https://cdn.divine.video/test123.mp4',
      { sha256: 'test123' },
      mockEnv,
      { fetchFn: mockFetch }
    );

    // Verify endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.thehive.ai/api/v2/task/sync',
      expect.any(Object)
    );

    // Verify token authentication header
    const callOptions = mockFetch.mock.calls[0][1];
    expect(callOptions.headers.authorization).toBe('token test-api-key');

    // Verify request body is FormData with url
    const body = callOptions.body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('url')).toBe('https://cdn.divine.video/test123.mp4');

    // Verify response
    expect(result).toEqual(mockResponse);
  });

  it('should include correct headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: [] })
    });

    await moderateVideoWithHiveAI(
      'https://cdn.divine.video/test.mp4',
      { sha256: 'test' },
      mockEnv,
      { fetchFn: mockFetch }
    );

    const callOptions = mockFetch.mock.calls[0][1];
    expect(callOptions.headers).toMatchObject({
      'accept': 'application/json'
      // NOTE: content-type is NOT set - FormData sets it automatically with boundary
    });
    expect(callOptions.headers.authorization).toBe('token test-api-key');
  });

  it('should throw error on API failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    });

    await expect(
      moderateVideoWithHiveAI(
        'https://cdn.divine.video/test.mp4',
        { sha256: 'test' },
        mockEnv,
        { fetchFn: mockFetch }
      )
    ).rejects.toThrow('Hive.AI V2 API error: 401 Unauthorized');
  });

  it('should pass video URL correctly in request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: [] })
    });

    const testUrl = 'https://cdn.divine.video/abc123xyz.mp4';
    await moderateVideoWithHiveAI(
      testUrl,
      { sha256: 'abc123xyz' },
      mockEnv,
      { fetchFn: mockFetch }
    );

    const callOptions = mockFetch.mock.calls[0][1];
    const body = callOptions.body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('url')).toBe(testUrl);
  });
});
