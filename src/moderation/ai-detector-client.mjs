// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Thin HTTP client for divine-ai-detector's POST /detect endpoint
// ABOUTME: Bounded retry + 429 Retry-After + circuit breaker. Failures become error envelopes.

// Per the design doc (2026-04-17-divine-ai-detector-design.md §API), the
// service returns one envelope per requested signal:
//
//   {
//     sha256, checked_at, duration_ms,
//     signals: {
//       watermark_visible: {
//         state: detected | absent | error | skipped,
//         class?: string,
//         confidence?: number,
//         frames_flagged?: number,
//         total_frames?: number,
//         model?: string,
//         error?: string
//       }
//     }
//   }
//
// On transport errors (timeout, non-2xx, malformed JSON) we synthesize an
// `error` envelope for every requested signal so callers have a uniform
// branch point and can fall through to vendor (Hive / Reality Defender).
//
// Resilience contract:
//   - Bounded retry on transient errors (network / timeout / 5xx / 429),
//     capped at 2 retries (3 attempts total) and a shared wall-clock budget.
//   - HTTP 429 honors Retry-After (delta-seconds or HTTP-date).
//   - A per-isolate circuit breaker sheds load after repeated failures.
//   - `circuit_state` ∈ {closed, half_open, open} is always present on the
//     response so callers / shadow mode can observe breaker state.

import {
  createCircuitBreaker,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN
} from './ai-detector-circuit-breaker.mjs';

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([100, 300]);
// If the remaining wall-clock budget is below this, don't bother starting
// another attempt — we'd spend more time on the backoff than on the request.
const MIN_ATTEMPT_BUDGET_MS = 50;

// Per spec §"Non-negotiable contracts": state ∈ {detected, absent, error, skipped}.
export const SIGNAL_STATES = Object.freeze(['detected', 'absent', 'error', 'skipped']);

// Singleton: one breaker per isolate. Tests can inject their own via
// `opts.circuitBreaker` to avoid cross-test contamination.
const defaultCircuitBreaker = createCircuitBreaker();

export function resolveBaseUrl(env) {
  if (!env) return null;
  if (env.AI_DETECTOR_BASE_URL) return env.AI_DETECTOR_BASE_URL;
  // Deprecated: LOGO_DETECTOR_MODEL_URL used to point at the ONNX model
  // directly. It is not the same shape as the new service base URL, but we
  // tolerate it during cutover so that deployed configs don't break if a
  // wrangler secret hasn't been rotated yet.
  if (env.LOGO_DETECTOR_MODEL_URL) return env.LOGO_DETECTOR_MODEL_URL;
  return null;
}

function errorEnvelope(_signal, message) {
  return {
    state: 'error',
    error: message,
    model: null
  };
}

function errorResponse(signals, message, circuitState) {
  const out = {};
  for (const sig of signals) out[sig] = errorEnvelope(sig, message);
  return {
    sha256: null,
    checked_at: new Date().toISOString(),
    duration_ms: 0,
    signals: out,
    transport_error: message,
    circuit_state: circuitState
  };
}

/**
 * Parse a Retry-After header into a delay in milliseconds.
 * Accepts delta-seconds (e.g. "3") or HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT").
 * Returns null if the value is missing or unparseable.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  // delta-seconds (RFC 7231 §7.1.3): a non-negative integer.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }

  // HTTP-date: parse with Date, then compute delta from now.
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  const delta = parsed - nowMs;
  return delta > 0 ? delta : 0;
}

/**
 * Sleep that honors an AbortSignal so a mid-backoff abort unblocks us.
 * Not aborted if signal is undefined.
 */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/**
 * Calls divine-ai-detector's POST /detect.
 *
 * @param {Object} req
 * @param {string} req.url          - media URL the service should fetch
 * @param {string} [req.mime_type]  - declared mime type of the media
 * @param {string} [req.sha256]     - sha256 cache key
 * @param {string[]} [req.signals]  - which signals to run; defaults to ['watermark_visible']
 * @param {Object} env              - Worker env bindings (must carry AI_DETECTOR_BASE_URL)
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs]               - total wall-clock budget, default DEFAULT_TIMEOUT_MS
 * @param {number[]} [opts.retryBackoffMs]        - backoff schedule, default [100, 300]
 * @param {typeof fetch} [opts.fetchImpl]         - override for tests
 * @param {Object} [opts.circuitBreaker]          - breaker instance; defaults to module singleton
 * @param {() => number} [opts.now]               - injectable clock
 * @param {(msg: string, ctx: Object) => void} [opts.log]
 * @returns {Promise<{sha256: string|null, checked_at: string, duration_ms: number, signals: Record<string,Object>, transport_error?: string, circuit_state: string}>}
 */
export async function detectSignals(req, env, opts = {}) {
  const signals = (req && req.signals && req.signals.length > 0)
    ? req.signals
    : ['watermark_visible'];

  const baseUrl = resolveBaseUrl(env);
  const breaker = opts.circuitBreaker || defaultCircuitBreaker;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  if (!baseUrl) {
    // No breaker interaction when misconfigured — config errors are not
    // upstream failures; we shouldn't trip the breaker on them.
    return errorResponse(signals, 'AI_DETECTOR_BASE_URL not configured', breaker.getState());
  }

  const admittedState = breaker.shouldAllow();
  if (admittedState === null) {
    return errorResponse(signals, 'circuit_open', STATE_OPEN);
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const backoffSchedule = Array.isArray(opts.retryBackoffMs) && opts.retryBackoffMs.length > 0
    ? opts.retryBackoffMs
    : DEFAULT_RETRY_BACKOFF_MS;
  const maxAttempts = backoffSchedule.length + 1; // e.g. [100,300] => 3 attempts

  const endpoint = baseUrl.replace(/\/+$/, '') + '/detect';
  const body = {
    url: req.url,
    mime_type: req.mime_type,
    sha256: req.sha256,
    signals
  };
  const serializedBody = JSON.stringify(body);

  const started = now();
  const deadline = started + timeoutMs;

  let lastError = null;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const remaining = deadline - now();
    // Only skip the attempt if budget is gone AND we've already tried once.
    // The first attempt always runs (with whatever budget we have) so that a
    // pathologically small timeoutMs still surfaces a real timeout error
    // instead of being short-circuited.
    if (remaining < MIN_ATTEMPT_BUDGET_MS && attempt > 1) {
      lastError = lastError || `timeout after ${timeoutMs}ms`;
      break;
    }

    const attemptBudget = Math.max(remaining, 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptBudget);

    let res;
    let networkErr = null;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serializedBody,
        signal: controller.signal
      });
    } catch (err) {
      networkErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (networkErr) {
      const isAbort = networkErr && networkErr.name === 'AbortError';
      // If the abort fired because the overall budget is gone, treat as timeout.
      if (isAbort && (deadline - now()) < MIN_ATTEMPT_BUDGET_MS) {
        lastError = `timeout after ${timeoutMs}ms`;
        break;
      }
      lastError = isAbort
        ? `timeout after ${timeoutMs}ms`
        : (networkErr && networkErr.message ? networkErr.message : 'fetch failed');
      // Network errors / timeouts are retryable — fall through to backoff.
      if (attempt >= maxAttempts) break;
      const backoff = backoffSchedule[attempt - 1];
      if ((deadline - now()) < backoff + MIN_ATTEMPT_BUDGET_MS) break;
      await sleep(backoff);
      continue;
    }

    // At this point we have a Response.
    const status = res ? res.status : 0;

    if (res && res.ok) {
      let payload;
      try {
        payload = await res.json();
      } catch (err) {
        // Malformed JSON is a contract bug, not a transient error — don't retry.
        breaker.recordFailure();
        return errorResponse(
          signals,
          `invalid JSON: ${err && err.message ? err.message : 'parse error'}`,
          breaker.getState()
        );
      }

      // Defensive: ensure every requested signal has an envelope even if the
      // service omits one (treat "missing" as skipped so callers can branch).
      // Unknown states (outside SIGNAL_STATES) are also treated as skipped.
      const merged = {};
      const respSignals = (payload && payload.signals) || {};
      for (const sig of signals) {
        const env_ = respSignals[sig];
        if (
          env_ &&
          typeof env_ === 'object' &&
          typeof env_.state === 'string' &&
          SIGNAL_STATES.includes(env_.state)
        ) {
          merged[sig] = env_;
        } else {
          merged[sig] = { state: 'skipped', model: null };
        }
      }

      breaker.recordSuccess();
      return {
        sha256: payload && payload.sha256 ? payload.sha256 : (req.sha256 || null),
        checked_at: payload && payload.checked_at ? payload.checked_at : new Date().toISOString(),
        duration_ms: payload && Number.isFinite(payload.duration_ms) ? payload.duration_ms : 0,
        signals: merged,
        circuit_state: breaker.getState()
      };
    }

    // Non-2xx. Decide whether to retry.
    lastError = `HTTP ${status}`;

    const retryable5xx = status >= 500 && status < 600;
    const is429 = status === 429;

    if (!retryable5xx && !is429) {
      // 4xx other than 429 — caller body / contract problem. Don't retry.
      breaker.recordFailure();
      return errorResponse(signals, `HTTP ${status}`, breaker.getState());
    }

    if (attempt >= maxAttempts) break;

    // Compute wait time before the next attempt.
    let waitMs = backoffSchedule[attempt - 1];

    if (is429 && res && res.headers) {
      const retryAfterRaw = typeof res.headers.get === 'function'
        ? res.headers.get('retry-after') || res.headers.get('Retry-After')
        : (res.headers['retry-after'] || res.headers['Retry-After']);
      const parsed = parseRetryAfter(retryAfterRaw, now());
      if (parsed !== null) {
        const budget = deadline - now();
        if (parsed > budget) {
          // Retry-After exceeds remaining budget — give up immediately.
          breaker.recordFailure();
          return errorResponse(signals, '429 Retry-After exceeds budget', breaker.getState());
        }
        waitMs = parsed;
      }
    }

    if ((deadline - now()) < waitMs + MIN_ATTEMPT_BUDGET_MS) break;
    await sleep(waitMs);
  }

  breaker.recordFailure();
  return errorResponse(signals, lastError || 'fetch failed', breaker.getState());
}

// Exposed for tests that want to reach into the module singleton.
export function _getDefaultCircuitBreaker() {
  return defaultCircuitBreaker;
}

export { STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN };
