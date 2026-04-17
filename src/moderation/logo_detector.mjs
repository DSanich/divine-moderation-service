// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Backwards-compat shim over ai-detector-client for the visible-watermark signal
// ABOUTME: In-Worker inference is gone — this module now maps watermark_visible envelopes
//
// History: originally a stub ONNX classifier running 4x 15% corner crops per
// frame inside the Worker. That inference has moved to the divine-ai-detector
// service (see docs/superpowers/plans/2026-04-17-divine-ai-detector-design.md).
// This file is kept as a compatibility layer so existing callers and tests
// that still import { detectLogos, loadModel, runInference, cropCorner,
// LOGO_CLASSES, CORNERS } continue to work. New code should prefer
// ai-detector-client.mjs directly.
//
// The stub `detectLogos` + `options.infer` test-injection path is preserved
// for unit tests only. In production, callers should use
// `envelopeToDetections(envelope, frameCount)` to adapt the service's
// per-signal `watermark_visible` envelope back into the per-frame/per-corner
// shape that logo_aggregator.mjs consumes. This keeps the aggregator's vote
// math stable during cutover.

export const LOGO_CLASSES = [
  'clean',
  'meta_sparkle',
  'openai_sora',
  'google_veo',
  'runway',
  'kling',
  'pika',
  'luma',
  'other_logo'
];

export const CORNERS = ['TL', 'TR', 'BL', 'BR'];

const CORNER_RATIO = 0.15;

// Kept for backwards-compat. There is no local model anymore; the presence of
// a non-empty URL just means "client is configured." `modelUrl` is treated as
// a base URL to divine-ai-detector — the old ONNX URL shape is tolerated for
// deprecated deployments (see ai-detector-client.mjs resolveBaseUrl).
export async function loadModel(modelUrl) {
  if (!modelUrl) {
    return { modelUrl: null, ready: false };
  }
  return { modelUrl, ready: true };
}

export async function loadModelFromEnv(env) {
  // Prefer the new env var; fall back to the deprecated one so existing
  // deployed configs keep working during rollout.
  const url = env && (env.AI_DETECTOR_BASE_URL || env.LOGO_DETECTOR_MODEL_URL)
    ? (env.AI_DETECTOR_BASE_URL || env.LOGO_DETECTOR_MODEL_URL)
    : null;
  return loadModel(url);
}

export function cropCorner(frame, corner) {
  if (!CORNERS.includes(corner)) {
    throw new Error(`unknown corner: ${corner}`);
  }
  return { frame, corner, ratio: CORNER_RATIO };
}

// Stub inference — only the unit tests still exercise this path now.
export async function runInference(_crop, _model) {
  return { class: 'clean', confidence: 1.0 };
}

// Test-only synthesis path: emits four detections per frame, one per corner.
// Production code should use detectSignals() from ai-detector-client.mjs and
// then envelopeToDetections() to adapt to the aggregator's input shape.
export async function detectLogos(frames, options = {}) {
  const { model = null, infer = runInference } = options;
  const detections = [];
  for (let frame_index = 0; frame_index < frames.length; frame_index++) {
    for (const corner of CORNERS) {
      const crop = cropCorner(frames[frame_index], corner);
      const result = await infer(crop, model);
      detections.push({
        frame_index,
        corner,
        class: result.class,
        confidence: result.confidence
      });
    }
  }
  return detections;
}

/**
 * Adapts a divine-ai-detector `watermark_visible` envelope back into the
 * per-frame/per-corner detections shape that logo_aggregator.mjs consumes.
 *
 * The service reports aggregate counts (frames_flagged, total_frames) rather
 * than per-frame/per-corner data, so this reconstructs detections that are
 * vote-equivalent for the aggregator:
 *
 *   - `detected`: emit `frames_flagged` flagged frames (all in corner 'BL'
 *     as a placeholder — aggregator's moving-watermark fallback ignores
 *     corner) plus (total_frames - frames_flagged) clean frames.
 *   - `absent` / `skipped`: emit `total_frames` clean frames.
 *   - `error`: return null so callers can branch to vendor fallback.
 *
 * This is a shim. The long-term plan is for the Worker's fusion layer to
 * consume envelopes directly without reconstructing detections.
 */
export function envelopeToDetections(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.state === 'error') return null;

  const total = Number.isFinite(envelope.total_frames) ? envelope.total_frames : 0;
  const flagged = envelope.state === 'detected' && Number.isFinite(envelope.frames_flagged)
    ? Math.min(envelope.frames_flagged, total)
    : 0;
  const cls = envelope.class || null;
  const confidence = Number.isFinite(envelope.confidence) ? envelope.confidence : 0;

  const detections = [];
  for (let i = 0; i < total; i++) {
    const isFlagged = i < flagged && cls;
    for (const corner of CORNERS) {
      if (isFlagged && corner === 'BL') {
        detections.push({ frame_index: i, corner, class: cls, confidence });
      } else {
        detections.push({ frame_index: i, corner, class: 'clean', confidence: 1.0 });
      }
    }
  }
  return detections;
}
