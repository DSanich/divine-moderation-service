// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for bounded retry, HTTP 429 Retry-After handling, and circuit breaker
// ABOUTME: in the divine-ai-detector HTTP client

import { describe, it, expect, vi } from 'vitest';
import {
  detectSignals,
  parseRetryAfter,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN
} from './ai-detector-client.mjs';
import { createCircuitBreaker } from './ai-detector-circuit-breaker.mjs';

// ---------------- helpers ----------------

function makeResponse({ status = 200, body = {}, headers = {}, throwOnJson = false } = {}) {
  const headerStore = {};
  for (const [k, v] of Object.entries(headers)) headerStore[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const k = String(name).toLowerCase();
        return k in headerStore ? headerStore[k] : null;
      }
    },
    json: async () => {
      if (throwOnJson) throw new Error('Unexpected token');
      return body;
    }
  };
}

/**
 * Build a fetch that returns responses from a scripted sequence. Each element
 * can be a response object or `{ throw: Error }` to simulate a network error,
 * or `{ delayMs, ... }` to delay before resolving/throwing.
 */
function scriptedFetch(script) {
  let i = 0;
  return vi.fn(async (_url, init) => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step && step.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, step.delayMs);
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
      });
    }
    if (step && step.throw) throw step.throw;
    return step.response || step;
  });
}

function envBase() {
  return { AI_DETECTOR_BASE_URL: 'https://svc' };
}

// A fresh breaker with a huge threshold so retry tests don't trip it.
function inertBreaker() {
  return createCircuitBreaker({ failureThreshold: 10_000, cooldownMs: 60_000 });
}

// ---------------- parseRetryAfter ----------------

describe('parseRetryAfter', () => {
  it('parses integer delta-seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('returns null for null / empty', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
  });

  it('returns null for unparseable strings', () => {
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
  });

  it('parses HTTP-date form relative to now', () => {
    const now = Date.parse('2026-04-17T12:00:00Z');
    const in5s = 'Fri, 17 Apr 2026 12:00:05 GMT';
    expect(parseRetryAfter(in5s, now)).toBe(5000);
  });

  it('returns 0 for an HTTP-date in the past', () => {
    const now = Date.parse('2026-04-17T12:00:00Z');
    const past = 'Thu, 21 Oct 2015 07:28:00 GMT';
    expect(parseRetryAfter(past, now)).toBe(0);
  });
});

// ---------------- Retry on transient errors ----------------

describe('ai-detector-client retry', () => {
  it('retries on 5xx and returns the successful response', async () => {
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 12,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    };
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 503 }),
      makeResponse({ status: 200, body: okBody })
    ]);

    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [10, 30], timeoutMs: 5000 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.signals.watermark_visible.state).toBe('absent');
    expect(result.circuit_state).toBe(STATE_CLOSED);
  });

  it('retries on network errors and succeeds on a later attempt', async () => {
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 1,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    };
    const fetchImpl = scriptedFetch([
      { throw: new Error('ECONNRESET') },
      makeResponse({ status: 200, body: okBody })
    ]);

    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [10, 30] }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.signals.watermark_visible.state).toBe('absent');
  });

  it('does not retry on HTTP 404 (non-429 4xx)', async () => {
    const fetchImpl = scriptedFetch([makeResponse({ status: 404 })]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [10, 30] }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/HTTP 404/);
  });

  it('does not retry on malformed JSON', async () => {
    const fetchImpl = scriptedFetch([makeResponse({ status: 200, throwOnJson: true })]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [10, 30] }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/invalid JSON/i);
  });

  it('gives up after maxAttempts with a consistent transport_error', async () => {
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 502 }),
      makeResponse({ status: 502 }),
      makeResponse({ status: 502 })
    ]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [5, 10], timeoutMs: 5000 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.signals.watermark_visible.state).toBe('error');
    expect(result.signals.watermark_visible.error).toMatch(/HTTP 502/);
  });

  it('budget exhaustion: first slow attempt consumes most of the budget', async () => {
    // timeoutMs=300. First attempt delays 250ms then errors (network). Second
    // attempt must run with < 50ms budget, so we break before issuing it.
    const fetchImpl = scriptedFetch([
      { delayMs: 250, throw: new Error('ECONNRESET') },
      makeResponse({ status: 200 }) // should never be reached
    ]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [100, 300], timeoutMs: 300 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.signals.watermark_visible.state).toBe('error');
  });
});

// ---------------- 429 Retry-After ----------------

describe('ai-detector-client 429 Retry-After', () => {
  it('honors a numeric Retry-After within budget', async () => {
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 1,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    };
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 429, headers: { 'Retry-After': '0' } }),
      makeResponse({ status: 200, body: okBody })
    ]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [1000, 3000], timeoutMs: 5000 }
    );
    // Retry-After: 0 means "retry immediately" — so we wait 0ms, not 1000ms.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.signals.watermark_visible.state).toBe('absent');
  });

  it('gives up immediately when Retry-After exceeds remaining budget', async () => {
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 429, headers: { 'Retry-After': '60' } }),
      makeResponse({ status: 200 })
    ]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [100, 300], timeoutMs: 5000 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.transport_error).toBe('429 Retry-After exceeds budget');
    expect(result.signals.watermark_visible.error).toBe('429 Retry-After exceeds budget');
  });

  it('honors Retry-After HTTP-date form', async () => {
    // Build a date ~2s from now.
    const future = new Date(Date.now() + 2000).toUTCString();
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 1,
      signals: { watermark_visible: { state: 'detected', confidence: 0.9, model: 'v1' } }
    };
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 429, headers: { 'Retry-After': future } }),
      makeResponse({ status: 200, body: okBody })
    ]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [10, 30], timeoutMs: 5000 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.signals.watermark_visible.state).toBe('detected');
  });

  it('falls back to backoff when Retry-After is unparseable', async () => {
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 1,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    };
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 429, headers: { 'Retry-After': 'not-a-date' } }),
      makeResponse({ status: 200, body: okBody })
    ]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: inertBreaker(), retryBackoffMs: [10, 30], timeoutMs: 5000 }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.signals.watermark_visible.state).toBe('absent');
  });
});

// ---------------- Circuit breaker ----------------

describe('ai-detector-circuit-breaker', () => {
  it('starts CLOSED and allows calls', () => {
    const cb = createCircuitBreaker();
    expect(cb.getState()).toBe(STATE_CLOSED);
    expect(cb.shouldAllow()).toBe(STATE_CLOSED);
  });

  it('opens after N consecutive failures', () => {
    const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(STATE_CLOSED);
    cb.recordFailure();
    expect(cb.getState()).toBe(STATE_OPEN);
    expect(cb.shouldAllow()).toBeNull();
  });

  it('resets consecutive failures on success', () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(STATE_CLOSED); // would have opened without the reset
  });

  it('half-opens after cooldown, and a successful probe closes it', () => {
    let t = 1_000_000;
    const cb = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: () => t
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(STATE_OPEN);
    expect(cb.shouldAllow()).toBeNull();

    // Advance past cooldown.
    t += 6_000;
    expect(cb.shouldAllow()).toBe(STATE_HALF_OPEN);
    expect(cb.getState()).toBe(STATE_HALF_OPEN);

    // Probe success -> CLOSED.
    cb.recordSuccess();
    expect(cb.getState()).toBe(STATE_CLOSED);
    expect(cb.shouldAllow()).toBe(STATE_CLOSED);
  });

  it('re-opens on probe failure with a fresh cooldown', () => {
    let t = 1_000_000;
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5_000,
      now: () => t
    });
    cb.recordFailure();
    expect(cb.getState()).toBe(STATE_OPEN);

    t += 6_000;
    expect(cb.shouldAllow()).toBe(STATE_HALF_OPEN);
    cb.recordFailure();
    expect(cb.getState()).toBe(STATE_OPEN);
    // Should still be blocked immediately after re-open.
    expect(cb.shouldAllow()).toBeNull();

    // And the new cooldown is measured from the probe-failure time.
    t += 6_000;
    expect(cb.shouldAllow()).toBe(STATE_HALF_OPEN);
  });

  it('allows only one probe in HALF_OPEN', () => {
    let t = 1_000_000;
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => t
    });
    cb.recordFailure();
    t += 2_000;
    expect(cb.shouldAllow()).toBe(STATE_HALF_OPEN);
    // Second request before probe outcome is reported -> rejected.
    expect(cb.shouldAllow()).toBeNull();
  });

  it('logs state transitions', () => {
    const logs = [];
    const log = (msg, ctx) => logs.push({ msg, ctx });
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, log, now: () => 1_000_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(logs.some(l => l.msg === 'ai-detector.circuit.open')).toBe(true);
  });
});

// ---------------- Circuit breaker wired into detectSignals ----------------

describe('detectSignals + circuit breaker', () => {
  it('short-circuits when breaker is OPEN without invoking fetch', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ status: 200 }));
    const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(); // trips OPEN

    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: cb, retryBackoffMs: [10, 30] }
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.transport_error).toBe('circuit_open');
    expect(result.circuit_state).toBe(STATE_OPEN);
    expect(result.signals.watermark_visible.state).toBe('error');
  });

  it('records a single failure per detectSignals call even across retries', async () => {
    // 5xx twice, then fail — we should see exactly one failure counted.
    const cb = createCircuitBreaker({ failureThreshold: 100, cooldownMs: 60_000 });
    const fetchImpl = scriptedFetch([
      makeResponse({ status: 500 }),
      makeResponse({ status: 500 }),
      makeResponse({ status: 500 })
    ]);

    await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: cb, retryBackoffMs: [5, 10], timeoutMs: 2000 }
    );

    expect(cb.getConsecutiveFailures()).toBe(1);
  });

  it('records a single success per detectSignals call regardless of retries', async () => {
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 1,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    };
    const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    // Pre-load some failures; a single successful call should wipe them.
    cb.recordFailure();
    cb.recordFailure();

    const fetchImpl = scriptedFetch([
      makeResponse({ status: 503 }),
      makeResponse({ status: 200, body: okBody })
    ]);

    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: cb, retryBackoffMs: [10, 30], timeoutMs: 5000 }
    );

    expect(result.signals.watermark_visible.state).toBe('absent');
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getState()).toBe(STATE_CLOSED);
  });

  it('opens after N consecutive failing detectSignals calls', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    // Each call: three 500s exhaust the retry loop, breaker records failure once.
    const makeFetch = () => scriptedFetch([
      makeResponse({ status: 500 }),
      makeResponse({ status: 500 }),
      makeResponse({ status: 500 })
    ]);

    const call = () => detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl: makeFetch(), circuitBreaker: cb, retryBackoffMs: [5, 10], timeoutMs: 2000 }
    );

    await call();
    await call();
    expect(cb.getState()).toBe(STATE_CLOSED);
    await call();
    expect(cb.getState()).toBe(STATE_OPEN);

    // Next call short-circuits.
    const sentinel = vi.fn(async () => makeResponse({ status: 200 }));
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl: sentinel, circuitBreaker: cb, retryBackoffMs: [5, 10] }
    );
    expect(sentinel).not.toHaveBeenCalled();
    expect(result.transport_error).toBe('circuit_open');
  });

  it('includes circuit_state on the happy path', async () => {
    const okBody = {
      sha256: 's', checked_at: 't', duration_ms: 1,
      signals: { watermark_visible: { state: 'absent', model: 'v1' } }
    };
    const cb = createCircuitBreaker();
    const fetchImpl = scriptedFetch([makeResponse({ status: 200, body: okBody })]);
    const result = await detectSignals(
      { url: 'u' },
      envBase(),
      { fetchImpl, circuitBreaker: cb }
    );
    expect(result.circuit_state).toBe(STATE_CLOSED);
  });

  it('does not trip the breaker when AI_DETECTOR_BASE_URL is missing', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    await detectSignals({ url: 'u' }, {}, { circuitBreaker: cb });
    expect(cb.getState()).toBe(STATE_CLOSED);
    expect(cb.getConsecutiveFailures()).toBe(0);
  });
});
