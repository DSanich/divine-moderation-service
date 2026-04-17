// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Thin HTTP client for divine-ai-detector's POST /detect endpoint
// ABOUTME: Returns per-signal envelopes; fetch failures become error envelopes

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

export const DEFAULT_TIMEOUT_MS = 5000;

// Per spec §"Non-negotiable contracts": state ∈ {detected, absent, error, skipped}.
export const SIGNAL_STATES = Object.freeze(['detected', 'absent', 'error', 'skipped']);

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

function errorEnvelope(signal, message) {
  return {
    state: 'error',
    error: message,
    model: null
  };
}

function errorResponse(signals, message) {
  const out = {};
  for (const sig of signals) out[sig] = errorEnvelope(sig, message);
  return {
    sha256: null,
    checked_at: new Date().toISOString(),
    duration_ms: 0,
    signals: out,
    transport_error: message
  };
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
 * @param {number} [opts.timeoutMs] - fetch timeout, default DEFAULT_TIMEOUT_MS
 * @param {typeof fetch} [opts.fetchImpl] - override for tests
 * @returns {Promise<{sha256: string|null, checked_at: string, duration_ms: number, signals: Record<string,Object>, transport_error?: string}>}
 */
export async function detectSignals(req, env, opts = {}) {
  const signals = (req && req.signals && req.signals.length > 0)
    ? req.signals
    : ['watermark_visible'];

  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) {
    return errorResponse(signals, 'AI_DETECTOR_BASE_URL not configured');
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const endpoint = baseUrl.replace(/\/+$/, '') + '/detect';
  const body = {
    url: req.url,
    mime_type: req.mime_type,
    sha256: req.sha256,
    signals
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err && err.name === 'AbortError'
      ? `timeout after ${timeoutMs}ms`
      : (err && err.message ? err.message : 'fetch failed');
    return errorResponse(signals, message);
  }
  clearTimeout(timer);

  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    return errorResponse(signals, `HTTP ${status}`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return errorResponse(signals, `invalid JSON: ${err && err.message ? err.message : 'parse error'}`);
  }

  // Defensive: ensure every requested signal has an envelope even if the
  // service omits one (treat "missing" as skipped so callers can branch).
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

  return {
    sha256: payload && payload.sha256 ? payload.sha256 : (req.sha256 || null),
    checked_at: payload && payload.checked_at ? payload.checked_at : new Date().toISOString(),
    duration_ms: payload && Number.isFinite(payload.duration_ms) ? payload.duration_ms : 0,
    signals: merged
  };
}
