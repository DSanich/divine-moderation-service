// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Aggregates per-frame logo detections into a single verdict
// ABOUTME: Static pass: majority vote per (corner, class); fallback: class-only for moving watermarks

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

function pickWinner(buckets, total_frames) {
  let winner = null;
  for (const [label, bucket] of buckets) {
    const frames_flagged = bucket.frames.size;
    if (frames_flagged / total_frames < FRAME_SHARE_THRESHOLD) continue;
    const confidence =
      bucket.confidences.reduce((a, b) => a + b, 0) / bucket.confidences.length;
    if (
      !winner ||
      frames_flagged > winner.frames_flagged ||
      (frames_flagged === winner.frames_flagged && confidence > winner.confidence)
    ) {
      winner = { label, class: bucket.class, confidence, frames_flagged };
    }
  }
  return winner;
}

export function aggregateLogoDetections(detections) {
  if (!detections || detections.length === 0) {
    return emptyResult();
  }

  const frameIndices = new Set();
  for (const d of detections) frameIndices.add(d.frame_index);
  const total_frames = frameIndices.size;

  // Static pass: key on (corner, class). Catches stationary corner logos
  // (Meta sparkle, Veo text, Runway/Kling/Pika/Luma corner marks).
  const staticVotes = new Map();
  // Fallback pass: key on class alone. Catches moving watermarks (Sora
  // wordmark) where a class-true flag hops corners across frames.
  const movingVotes = new Map();

  for (const d of detections) {
    if (d.class === 'clean') continue;
    if (d.confidence < CONFIDENCE_FLOOR) continue;

    const staticKey = `${d.corner}|${d.class}`;
    let sBucket = staticVotes.get(staticKey);
    if (!sBucket) {
      sBucket = { class: d.class, frames: new Set(), confidences: [] };
      staticVotes.set(staticKey, sBucket);
    }
    if (!sBucket.frames.has(d.frame_index)) {
      sBucket.frames.add(d.frame_index);
      sBucket.confidences.push(d.confidence);
    }

    let mBucket = movingVotes.get(d.class);
    if (!mBucket) {
      mBucket = { class: d.class, frames: new Set(), confidences: [] };
      movingVotes.set(d.class, mBucket);
    }
    if (!mBucket.frames.has(d.frame_index)) {
      mBucket.frames.add(d.frame_index);
      mBucket.confidences.push(d.confidence);
    }
  }

  // Static pass wins by construction: a class-only bucket always has >= the
  // frames of any single (corner, class) slice of it, so a static winner
  // implies the moving winner of the same class would tie or beat on count.
  // We prefer the static winner because it's a tighter, higher-signal match.
  const winner = pickWinner(staticVotes, total_frames)
    || pickWinner(movingVotes, total_frames);

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
