// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: In-memory circuit breaker for the divine-ai-detector HTTP client
// ABOUTME: CLOSED -> OPEN on N consecutive failures; HALF_OPEN after cooldown; one probe at a time
//
// Design note: breaker state is intentionally per-isolate / in-memory. Cloudflare
// Workers recreate isolates on cold start and on deploy, which is a reasonable
// reset point for a fast-fail breaker whose only job is to shed load while the
// upstream is visibly unhealthy. Persisting state to KV or a Durable Object
// would add its own failure modes and latency; we want the breaker to be a
// *relief valve*, not another cross-service hop. If one isolate's breaker is
// open while another's is closed, the open one stops calling until its own
// samples recover — which is the correct behavior for per-isolate back-pressure.

export const STATE_CLOSED = 'closed';
export const STATE_OPEN = 'open';
export const STATE_HALF_OPEN = 'half_open';

/**
 * Creates a circuit breaker.
 *
 * States:
 *   CLOSED     — normal operation; track consecutive failures.
 *   OPEN       — fail fast; reject all calls until cooldown elapses.
 *   HALF_OPEN  — allow exactly one probe through. While that probe is in
 *                flight, further calls are rejected (no thundering herd).
 *                Success closes, failure re-opens with a fresh cooldown.
 *
 * @param {Object} [opts]
 * @param {number} [opts.failureThreshold=5]  consecutive failures that trip OPEN
 * @param {number} [opts.cooldownMs=10000]    ms to stay OPEN before HALF_OPEN
 * @param {() => number} [opts.now]           injectable clock for tests
 * @param {(msg: string, ctx: Object) => void} [opts.log]
 */
export function createCircuitBreaker({
  failureThreshold = 5,
  cooldownMs = 10_000,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  let state = STATE_CLOSED;
  let consecutiveFailures = 0;
  let openedAt = 0;        // ms timestamp of most recent OPEN transition
  let probeInFlight = false;

  function transition(next, ctx = {}) {
    if (state === next) return;
    state = next;
    if (next === STATE_OPEN) {
      log('ai-detector.circuit.open', { consecutive_failures: consecutiveFailures, ...ctx });
    } else if (next === STATE_HALF_OPEN) {
      log('ai-detector.circuit.half_open', { consecutive_failures: consecutiveFailures, ...ctx });
    } else if (next === STATE_CLOSED) {
      log('ai-detector.circuit.close', ctx);
    }
  }

  function shouldAllow() {
    if (state === STATE_CLOSED) {
      return STATE_CLOSED;
    }

    if (state === STATE_OPEN) {
      const elapsed = now() - openedAt;
      if (elapsed < cooldownMs) {
        return null; // still cooling down
      }
      // Cooldown elapsed — move to HALF_OPEN and let THIS caller be the probe.
      transition(STATE_HALF_OPEN);
      probeInFlight = true;
      return STATE_HALF_OPEN;
    }

    // HALF_OPEN: only one probe allowed at a time.
    if (state === STATE_HALF_OPEN) {
      if (probeInFlight) {
        return null;
      }
      probeInFlight = true;
      return STATE_HALF_OPEN;
    }

    return null;
  }

  function recordSuccess() {
    consecutiveFailures = 0;
    probeInFlight = false;
    if (state !== STATE_CLOSED) {
      transition(STATE_CLOSED);
    }
  }

  function recordFailure() {
    probeInFlight = false;
    if (state === STATE_HALF_OPEN) {
      // Probe failed: slam back OPEN with a fresh cooldown.
      openedAt = now();
      transition(STATE_OPEN, { from: 'half_open' });
      return;
    }
    consecutiveFailures += 1;
    if (state === STATE_CLOSED && consecutiveFailures >= failureThreshold) {
      openedAt = now();
      transition(STATE_OPEN);
    }
  }

  return {
    shouldAllow,
    recordSuccess,
    recordFailure,
    // Inspectors (useful for tests and for surfacing state in responses).
    getState: () => state,
    getConsecutiveFailures: () => consecutiveFailures
  };
}
