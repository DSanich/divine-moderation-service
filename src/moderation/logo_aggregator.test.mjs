// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for logo detection aggregation / majority vote across frames
// ABOUTME: Covers clean, single false positive, consistent logo, mixed signals

import { describe, it, expect } from 'vitest';
import { aggregateLogoDetections } from './logo_aggregator.mjs';

function cleanFrame(frameIndex) {
  return ['TL', 'TR', 'BL', 'BR'].map((corner) => ({
    frame_index: frameIndex,
    corner,
    class: 'clean',
    confidence: 1.0
  }));
}

function flagCorner(frameIndex, corner, cls, confidence) {
  return ['TL', 'TR', 'BL', 'BR'].map((c) => ({
    frame_index: frameIndex,
    corner: c,
    class: c === corner ? cls : 'clean',
    confidence: c === corner ? confidence : 1.0
  }));
}

describe('aggregateLogoDetections', () => {
  it('returns undetected for an empty detection list', () => {
    expect(aggregateLogoDetections([])).toEqual({
      detected: false,
      class: null,
      confidence: 0,
      frames_flagged: 0,
      total_frames: 0
    });
  });

  it('returns undetected for null input', () => {
    expect(aggregateLogoDetections(null)).toEqual({
      detected: false,
      class: null,
      confidence: 0,
      frames_flagged: 0,
      total_frames: 0
    });
  });

  it('returns undetected when every frame is clean', () => {
    const detections = [];
    for (let i = 0; i < 5; i++) detections.push(...cleanFrame(i));

    const result = aggregateLogoDetections(detections);
    expect(result).toEqual({
      detected: false,
      class: null,
      confidence: 0,
      frames_flagged: 0,
      total_frames: 5
    });
  });

  it('ignores a single-frame false positive below the 50% threshold', () => {
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.95),
      ...cleanFrame(1),
      ...cleanFrame(2),
      ...cleanFrame(3),
      ...cleanFrame(4)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(false);
    expect(result.class).toBeNull();
    expect(result.total_frames).toBe(5);
    expect(result.frames_flagged).toBe(0);
  });

  it('ignores flags below the 0.7 confidence floor', () => {
    const detections = [];
    for (let i = 0; i < 4; i++) {
      detections.push(...flagCorner(i, 'BL', 'meta_sparkle', 0.65));
    }

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(false);
    expect(result.class).toBeNull();
    expect(result.total_frames).toBe(4);
    expect(result.frames_flagged).toBe(0);
  });

  it('triggers when a logo is flagged in the same corner on >=50% of frames at conf>=0.7', () => {
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(1, 'BL', 'meta_sparkle', 0.85),
      ...flagCorner(2, 'BL', 'meta_sparkle', 0.8),
      ...cleanFrame(3)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(true);
    expect(result.class).toBe('meta_sparkle');
    expect(result.frames_flagged).toBe(3);
    expect(result.total_frames).toBe(4);
    expect(result.confidence).toBeCloseTo((0.9 + 0.85 + 0.8) / 3, 5);
  });

  it('requires the flags to be in the same corner, not scattered across corners', () => {
    const detections = [
      ...flagCorner(0, 'TL', 'meta_sparkle', 0.9),
      ...flagCorner(1, 'TR', 'meta_sparkle', 0.9),
      ...flagCorner(2, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(3, 'BR', 'meta_sparkle', 0.9)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(false);
    expect(result.class).toBeNull();
    expect(result.total_frames).toBe(4);
  });

  it('requires the flags to agree on a single class, not a mix', () => {
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(1, 'BL', 'openai_sora', 0.9),
      ...flagCorner(2, 'BL', 'google_veo', 0.9),
      ...flagCorner(3, 'BL', 'runway', 0.9)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(false);
    expect(result.class).toBeNull();
  });

  it('triggers at exactly 50% frames flagged', () => {
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(1, 'BL', 'meta_sparkle', 0.9),
      ...cleanFrame(2),
      ...cleanFrame(3)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(true);
    expect(result.class).toBe('meta_sparkle');
    expect(result.frames_flagged).toBe(2);
    expect(result.total_frames).toBe(4);
  });

  it('picks the strongest vote when two classes both exceed the 50% threshold', () => {
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(1, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(2, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(0, 'TR', 'openai_sora', 0.8),
      ...flagCorner(1, 'TR', 'openai_sora', 0.8)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(true);
    expect(result.class).toBe('meta_sparkle');
    expect(result.frames_flagged).toBe(3);
  });

  it('prefers the later vote when it covers more frames than the running winner', () => {
    // First-inserted (BL|meta_sparkle) wins 2/4; later (TR|openai_sora) wins 3/4.
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(1, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(0, 'TR', 'openai_sora', 0.8),
      ...flagCorner(1, 'TR', 'openai_sora', 0.8),
      ...flagCorner(2, 'TR', 'openai_sora', 0.8),
      ...cleanFrame(3)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(true);
    expect(result.class).toBe('openai_sora');
    expect(result.frames_flagged).toBe(3);
    expect(result.total_frames).toBe(4);
  });

  it('breaks ties on frame count using average confidence', () => {
    // Both BL|meta_sparkle and TR|openai_sora flag 2 of 3 frames. TR has higher conf.
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.72),
      ...flagCorner(1, 'BL', 'meta_sparkle', 0.72),
      ...flagCorner(0, 'TR', 'openai_sora', 0.95),
      ...flagCorner(1, 'TR', 'openai_sora', 0.95),
      ...cleanFrame(2)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(true);
    expect(result.class).toBe('openai_sora');
    expect(result.frames_flagged).toBe(2);
    expect(result.confidence).toBeCloseTo(0.95, 5);
  });

  it('counts each frame at most once per corner even with duplicate detections', () => {
    const detections = [
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.9),
      ...flagCorner(0, 'BL', 'meta_sparkle', 0.95),
      ...flagCorner(1, 'BL', 'meta_sparkle', 0.9),
      ...cleanFrame(2)
    ];

    const result = aggregateLogoDetections(detections);
    expect(result.frames_flagged).toBe(2);
    expect(result.total_frames).toBe(3);
    expect(result.detected).toBe(true);
  });
});
