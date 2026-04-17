// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Visible-watermark detector for consumer AI video generators
// ABOUTME: Crops four 15% corners per frame and runs a stub classifier per crop
//
// The actual ONNX model (Meta sparkle, Sora, Veo, Runway, Kling, Pika, Luma corner
// logos) is loaded lazily via `loadModel()` + `runInference()`. Both are stubs
// until the trained classifier is wired in through onnxruntime-web — tests drive
// behaviour by injecting `options.infer`.

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

export async function loadModel(modelUrl) {
  if (!modelUrl) {
    return { modelUrl: null, ready: false };
  }
  return { modelUrl, ready: true };
}

export function cropCorner(frame, corner) {
  if (!CORNERS.includes(corner)) {
    throw new Error(`unknown corner: ${corner}`);
  }
  return { frame, corner, ratio: CORNER_RATIO };
}

export async function runInference(_crop, _model) {
  return { class: 'clean', confidence: 1.0 };
}

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
