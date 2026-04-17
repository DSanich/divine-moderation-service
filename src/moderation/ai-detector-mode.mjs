// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Per-signal cutover mode dispatcher (shadow | gated | preferred | sole)
// ABOUTME: Decides whether to use divine-ai-detector's verdict or fall through to vendor

// Per the design doc §"Cutover strategy — four modes, per signal", each
// signal has its own env var: AI_DETECTOR_MODE_<SIGNAL>, and each signal
// optionally has a gate threshold env var: AI_DETECTOR_GATE_<SIGNAL>.
//
//   shadow     — call both, use vendor, log both + disagreement.
//   gated      — internal when confidence >= GATE; else vendor.
//   preferred  — internal when state != error; else vendor.
//   sole       — internal only. Vendor not called.
//
// Default for every signal is 'shadow'. Flip via env, not via deploy.

export const MODES = Object.freeze(['shadow', 'gated', 'preferred', 'sole']);
export const DEFAULT_MODE = 'shadow';
export const DEFAULT_GATE = 0.8;

function upperSignal(signal) {
  return String(signal || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function readMode(env, signal) {
  if (!env) return DEFAULT_MODE;
  const key = `AI_DETECTOR_MODE_${upperSignal(signal)}`;
  const raw = env[key];
  if (!raw) return DEFAULT_MODE;
  const v = String(raw).trim().toLowerCase();
  return MODES.includes(v) ? v : DEFAULT_MODE;
}

export function readGate(env, signal) {
  if (!env) return DEFAULT_GATE;
  const key = `AI_DETECTOR_GATE_${upperSignal(signal)}`;
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') return DEFAULT_GATE;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_GATE;
}

/**
 * Given a signal's internal envelope (from divine-ai-detector), a function
 * that produces the vendor verdict (called lazily — not invoked in 'sole'),
 * and the mode/gate, decide which verdict to return and produce a log record
 * capturing both sides for later calibration.
 *
 * The vendor shape is opaque to this dispatcher — we hand it through as-is.
 *
 * @param {Object} args
 * @param {string} args.signal
 * @param {Object} args.internal             - envelope from detectSignals()
 * @param {() => Promise<any>} args.callVendor - lazy vendor call
 * @param {Object} args.env
 * @param {(msg: string, ctx: Object) => void} [args.log]
 * @returns {Promise<{verdict: any, source: 'internal'|'vendor', mode: string, disagreement?: boolean}>}
 */
export async function dispatchSignal({ signal, internal, callVendor, env, log }) {
  const mode = readMode(env, signal);
  const gate = readGate(env, signal);
  const logFn = typeof log === 'function' ? log : () => {};

  const internalErrored = !internal || internal.state === 'error' || internal.state === 'skipped';
  const confidence = internal && Number.isFinite(internal.confidence) ? internal.confidence : 0;

  switch (mode) {
    case 'sole': {
      // Vendor never called. Caller must tolerate internal errors.
      logFn('ai-detector.dispatch', { signal, mode, source: 'internal', internal });
      return { verdict: internal, source: 'internal', mode };
    }

    case 'preferred': {
      if (!internalErrored) {
        logFn('ai-detector.dispatch', { signal, mode, source: 'internal', internal });
        return { verdict: internal, source: 'internal', mode };
      }
      const vendor = await callVendor();
      logFn('ai-detector.dispatch', { signal, mode, source: 'vendor', internal, vendor, reason: 'internal_error' });
      return { verdict: vendor, source: 'vendor', mode };
    }

    case 'gated': {
      if (!internalErrored && confidence >= gate) {
        logFn('ai-detector.dispatch', { signal, mode, source: 'internal', internal, gate });
        return { verdict: internal, source: 'internal', mode };
      }
      const vendor = await callVendor();
      logFn('ai-detector.dispatch', {
        signal, mode, source: 'vendor', internal, vendor, gate,
        reason: internalErrored ? 'internal_error' : 'below_gate'
      });
      return { verdict: vendor, source: 'vendor', mode };
    }

    case 'shadow':
    default: {
      // Shadow: call both, use vendor verdict, log disagreement for calibration.
      const vendor = await callVendor();
      const disagreement = computeDisagreement(internal, vendor);
      logFn('ai-detector.shadow', {
        signal, mode: 'shadow', source: 'vendor',
        internal, vendor, disagreement
      });
      return { verdict: vendor, source: 'vendor', mode: 'shadow', disagreement };
    }
  }
}

// Heuristic: mark disagreement when internal says detected but vendor says
// nothing suspicious, or vice versa. Vendor shape is unknown here so we only
// look at the fields that might be present (ai_generated score, detected
// boolean). Caller can override by providing its own logger that re-derives
// this from its own knowledge of the vendor payload.
function computeDisagreement(internal, vendor) {
  const internalDetected = internal && internal.state === 'detected';
  const vendorDetected =
    vendor && (
      vendor.detected === true ||
      (Number.isFinite(vendor.ai_generated) && vendor.ai_generated >= 0.7) ||
      (Number.isFinite(vendor.confidence) && vendor.confidence >= 0.7 && vendor.class)
    );
  return internalDetected !== vendorDetected;
}
