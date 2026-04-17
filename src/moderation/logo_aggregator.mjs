// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Aggregates per-frame logo detections into a single verdict
// ABOUTME: Majority vote per (corner, class) at confidence>=0.7, triggers at >=50% frames

const CONFIDENCE_FLOOR = 0.7;
const FRAME_SHARE_THRESHOLD = 0.5;

function emptyResult(total_frames = 0) {
  return {
    detected: false,
    class: null,
    confidence: 0,
    frames_flagged: 0,
    total_frames
  };
}

export function aggregateLogoDetections(detections) {
  if (!detections || detections.length === 0) {
    return emptyResult();
  }

  const frameIndices = new Set();
  for (const d of detections) frameIndices.add(d.frame_index);
  const total_frames = frameIndices.size;

  // key = `${corner}|${class}` -> { frames: Set<frame_index>, confidences: number[] }
  const votes = new Map();
  for (const d of detections) {
    if (d.class === 'clean') continue;
    if (d.confidence < CONFIDENCE_FLOOR) continue;
    const key = `${d.corner}|${d.class}`;
    let bucket = votes.get(key);
    if (!bucket) {
      bucket = { frames: new Set(), confidences: [] };
      votes.set(key, bucket);
    }
    if (!bucket.frames.has(d.frame_index)) {
      bucket.frames.add(d.frame_index);
      bucket.confidences.push(d.confidence);
    }
  }

  let winner = null;
  for (const [key, bucket] of votes) {
    const frames_flagged = bucket.frames.size;
    const share = frames_flagged / total_frames;
    if (share < FRAME_SHARE_THRESHOLD) continue;
    const [, cls] = key.split('|');
    const confidence =
      bucket.confidences.reduce((a, b) => a + b, 0) / bucket.confidences.length;
    if (
      !winner ||
      frames_flagged > winner.frames_flagged ||
      (frames_flagged === winner.frames_flagged && confidence > winner.confidence)
    ) {
      winner = { class: cls, confidence, frames_flagged };
    }
  }

  if (!winner) {
    return emptyResult(total_frames);
  }

  return {
    detected: true,
    class: winner.class,
    confidence: winner.confidence,
    frames_flagged: winner.frames_flagged,
    total_frames
  };
}
