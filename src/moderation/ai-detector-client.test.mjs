// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the divine-ai-detector HTTP client
// ABOUTME: Covers happy path, non-2xx, transport failure, timeout, env resolution

import { describe, it, expect, vi } from 'vitest';
import {
  detectSignals,
  resolveBaseUrl,
  SIGNAL_STATES,
  DEFAULT_TIMEOUT_MS
} from './ai-detector-client.mjs';

function mockFetch(response, { delayMs = 0, throwError = null } = {}) {
  return vi.fn(async (_url, _init) => {
    if (throwError) {
      if (_init && _init.signal) {
        // Respect aborts so timeout tests can pass.
        if (_init.signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      }
      throw throwError;
    }
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (_init && _init.signal) {
          _init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    return response;
  });
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

describe('ai-detector-client - SIGNAL_STATES', () => {
  it('exposes the four spec-defined states', () => {
    expect(SIGNAL_STATES).toEqual(['detected', 'absent', 'error', 'skipped']);
  });
});

describe('ai-detector-client - resolveBaseUrl', () => {
  it('prefers AI_DETECTOR_BASE_URL', () => {
    expect(resolveBaseUrl({
      AI_DETECTOR_BASE_URL: 'https://ai-detector.staging.divine.video',
      LOGO_DETECTOR_MODEL_URL: 'https://old.example/model.onnx'
    })).toBe('https://ai-detector.staging.divine.video');
  });

  it('falls back to LOGO_DETECTOR_MODEL_URL during cutover', () => {
    expect(resolveBaseUrl({
      LOGO_DETECTOR_MODEL_URL: 'https://old.example/model.onnx'
    })).toBe('https://old.example/model.onnx');
  });

  it('returns null when env is null', () => {
    expect(resolveBaseUrl(null)).toBeNull();
  });

  it('returns null when neither var is set', () => {
    expect(resolveBaseUrl({})).toBeNull();
  });
});

describe('ai-detector-client - detectSignals happy path', () => {
  it('returns the parsed envelope when the service responds 200', async () => {
    const body = {
      sha256: 'abc123',
      checked_at: '2026-04-17T12:00:00Z',
      duration_ms: 430,
      signals: {
        watermark_visible: {
          state: 'detected',
          class: 'meta_sparkle',
          confidence: 0.92,
          frames_flagged: 3,
          total_frames: 4,
          model: 'logo-v1.2.0'
        }
      }
    };
    const fetchImpl = mockFetch(jsonResponse(body));
    const env = { AI_DETECTOR_BASE_URL: 'https://ai-detector.divine.video' };

    const result = await detectSignals(
      { url: 'https://media.divine.video/abc123.mp4', mime_type: 'video/mp4', sha256: 'abc123' },
      env,
      { fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://ai-detector.divine.video/detect');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://media.divine.video/abc123.mp4',
      mime_type: 'video/mp4',
      sha256: 'abc123',
      signals: ['watermark_visible']
    });

    expect(result.sha256).toBe('abc123');
    expect(result.duration_ms).toBe(430);
    expect(result.signals.watermark_visible).toEqual(body.signals.watermark_visible);
  });

  it('defaults to requesting the watermark_visible signal', async () => {
    const fetchImpl = mockFetch(jsonResponse({
      sha256: 'x',
      checked_at: 'now',
      duration_ms: 1,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    }));
    await detectSignals({ url: 'u' }, { AI_DETECTOR_BASE_URL: 'https://svc' }, { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.signals).toEqual(['watermark_visible']);
  });

  it('trims trailing slashes from the base URL', async () => {
    const fetchImpl = mockFetch(jsonResponse({
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    }));
    await detectSignals({ url: 'u' }, { AI_DETECTOR_BASE_URL: 'https://svc///' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc/detect');
  });

  it('treats a missing envelope for a requested signal as skipped', async () => {
    const fetchImpl = mockFetch(jsonResponse({
      sha256: 'x', checked_at: 'now', duration_ms: 1,
      signals: {} // service returned nothing for the requested signal
    }));
    const result = await detectSignals(
      { url: 'u', signals: ['watermark_visible'] },
      { AI_DETECTOR_BASE_URL: 'https://svc' },
      { fetchImpl }
    );
    expect(result.signals.watermark_visible).toEqual({ state: 'skipped', model: null });
  });

  it('treats an envelope with an unknown state as skipped', async () => {
    const fetchImpl = mockFetch(jsonResponse({
      sha256: 'x', checked_at: 'now', duration_ms: 1,
      signals: { watermark_visible: { state: 'mystery', model: 'v1' } }
    }));
    const result = await detectSignals(
      { url: 'u', signals: ['watermark_visible'] },
      { AI_DETECTOR_BASE_URL: 'https://svc' },
      { fetchImpl }
    );
    expect(result.signals.watermark_visible).toEqual({ state: 'skipped', model: null });
  });
});

describe('ai-detector-client - error paths', () => {
  it('returns an error envelope when base URL is missing', async () => {
    const result = await detectSignals({ url: 'u' }, {});
    expect(result.transport_error).toMatch(/not configured/i);
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/not configured/i);
  });

  it('returns an error envelope per requested signal on non-2xx', async () => {
    const fetchImpl = mockFetch(jsonResponse({}, { status: 500 }));
    const result = await detectSignals(
      { url: 'u', signals: ['watermark_visible'] },
      { AI_DETECTOR_BASE_URL: 'https://svc' },
      { fetchImpl }
    );
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/HTTP 500/);
  });

  it('returns an error envelope on network failure', async () => {
    const fetchImpl = mockFetch(null, { throwError: new Error('ECONNREFUSED') });
    const result = await detectSignals(
      { url: 'u' },
      { AI_DETECTOR_BASE_URL: 'https://svc' },
      { fetchImpl }
    );
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toBe('ECONNREFUSED');
  });

  it('returns an error envelope with a timeout message when fetch exceeds timeoutMs', async () => {
    const fetchImpl = mockFetch(jsonResponse({}), { delayMs: 200 });
    const result = await detectSignals(
      { url: 'u' },
      { AI_DETECTOR_BASE_URL: 'https://svc' },
      { fetchImpl, timeoutMs: 10 }
    );
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/timeout/i);
  });

  it('returns an error envelope when the response is invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Unexpected token'); }
    }));
    const result = await detectSignals(
      { url: 'u' },
      { AI_DETECTOR_BASE_URL: 'https://svc' },
      { fetchImpl }
    );
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/invalid JSON/i);
  });

  it('honors DEFAULT_TIMEOUT_MS as a sensible default', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30000);
  });
});
