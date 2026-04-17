// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for visible-watermark detector on AI-generated video
// ABOUTME: Covers corner cropping, stub inference, and detection shape

import { describe, it, expect } from 'vitest';
import {
  detectLogos,
  loadModel,
  loadModelFromEnv,
  runInference,
  cropCorner,
  envelopeToDetections,
  LOGO_CLASSES,
  CORNERS
} from './logo_detector.mjs';
import { aggregateLogoDetections } from './logo_aggregator.mjs';

describe('logo_detector - constants', () => {
  it('exposes the nine classifier classes in a stable order', () => {
    expect(LOGO_CLASSES).toEqual([
      'clean',
      'meta_sparkle',
      'openai_sora',
      'google_veo',
      'runway',
      'kling',
      'pika',
      'luma',
      'other_logo'
    ]);
  });

  it('exposes the four corners in TL, TR, BL, BR order', () => {
    expect(CORNERS).toEqual(['TL', 'TR', 'BL', 'BR']);
  });
});

describe('logo_detector - loadModel', () => {
  it('returns a handle that records the provided model URL', async () => {
    const model = await loadModel('https://example.com/model.onnx');
    expect(model).toMatchObject({
      modelUrl: 'https://example.com/model.onnx',
      ready: true
    });
  });

  it('handles a missing model URL by returning a non-ready handle', async () => {
    const model = await loadModel(null);
    expect(model.ready).toBe(false);
    expect(model.modelUrl).toBeNull();
  });
});

describe('logo_detector - loadModelFromEnv', () => {
  it('loads the model from env.LOGO_DETECTOR_MODEL_URL', async () => {
    const env = { LOGO_DETECTOR_MODEL_URL: 'https://models.divine.video/logo-v1.onnx' };
    const model = await loadModelFromEnv(env);
    expect(model).toEqual({
      modelUrl: 'https://models.divine.video/logo-v1.onnx',
      ready: true
    });
  });

  it('returns a non-ready handle when the env var is empty', async () => {
    const model = await loadModelFromEnv({ LOGO_DETECTOR_MODEL_URL: '' });
    expect(model).toEqual({ modelUrl: null, ready: false });
  });

  it('returns a non-ready handle when the env var is missing entirely', async () => {
    const model = await loadModelFromEnv({});
    expect(model.ready).toBe(false);
    expect(model.modelUrl).toBeNull();
  });

  it('returns a non-ready handle when env itself is null', async () => {
    const model = await loadModelFromEnv(null);
    expect(model.ready).toBe(false);
    expect(model.modelUrl).toBeNull();
  });

  it('prefers AI_DETECTOR_BASE_URL over the deprecated LOGO_DETECTOR_MODEL_URL', async () => {
    const env = {
      AI_DETECTOR_BASE_URL: 'https://ai-detector.divine.video',
      LOGO_DETECTOR_MODEL_URL: 'https://old.example/model.onnx'
    };
    const model = await loadModelFromEnv(env);
    expect(model).toEqual({
      modelUrl: 'https://ai-detector.divine.video',
      ready: true
    });
  });

  it('falls back to LOGO_DETECTOR_MODEL_URL for deployed configs that have not been rotated', async () => {
    const env = { LOGO_DETECTOR_MODEL_URL: 'https://models.divine.video/logo-v1.onnx' };
    const model = await loadModelFromEnv(env);
    expect(model.ready).toBe(true);
    expect(model.modelUrl).toBe('https://models.divine.video/logo-v1.onnx');
  });
});

describe('logo_detector - envelopeToDetections', () => {
  it('returns null for an error envelope so callers can fall through to vendor', () => {
    expect(envelopeToDetections({ state: 'error', error: 'boom', model: 'v1' })).toBeNull();
  });

  it('returns null when given a null envelope', () => {
    expect(envelopeToDetections(null)).toBeNull();
  });

  it('emits all-clean detections for an absent envelope with total_frames', () => {
    const detections = envelopeToDetections({
      state: 'absent', total_frames: 3, model: 'v1'
    });
    expect(detections).toHaveLength(12); // 3 frames × 4 corners
    for (const d of detections) {
      expect(d.class).toBe('clean');
      expect(d.confidence).toBe(1.0);
    }
  });

  it('emits flagged + clean detections for a detected envelope that aggregator agrees with', () => {
    const envelope = {
      state: 'detected',
      class: 'meta_sparkle',
      confidence: 0.9,
      frames_flagged: 3,
      total_frames: 4,
      model: 'logo-v1.2.0'
    };
    const detections = envelopeToDetections(envelope);
    expect(detections).toHaveLength(16);

    const result = aggregateLogoDetections(detections);
    expect(result.detected).toBe(true);
    expect(result.class).toBe('meta_sparkle');
    expect(result.frames_flagged).toBe(3);
    expect(result.total_frames).toBe(4);
  });

  it('emits zero detections for a detected envelope with total_frames=0', () => {
    const detections = envelopeToDetections({
      state: 'detected', class: 'meta_sparkle', confidence: 0.9,
      frames_flagged: 0, total_frames: 0, model: 'v1'
    });
    expect(detections).toEqual([]);
  });

  it('caps frames_flagged at total_frames to avoid aggregator double-counting', () => {
    const detections = envelopeToDetections({
      state: 'detected', class: 'meta_sparkle', confidence: 0.9,
      frames_flagged: 99, total_frames: 4, model: 'v1'
    });
    const result = aggregateLogoDetections(detections);
    expect(result.frames_flagged).toBe(4);
    expect(result.total_frames).toBe(4);
  });
});

describe('logo_detector - cropCorner', () => {
  it('returns a crop descriptor covering 15% of the frame', () => {
    const frame = 'https://cdn/frame-0.jpg';
    const crop = cropCorner(frame, 'TL');
    expect(crop).toEqual({ frame, corner: 'TL', ratio: 0.15 });
  });

  it('rejects an unknown corner', () => {
    expect(() => cropCorner('frame', 'XY')).toThrow(/unknown corner/i);
  });
});

describe('logo_detector - runInference (stub)', () => {
  it('returns clean/1.0 until an ONNX model is wired in', async () => {
    const crop = { frame: 'f', corner: 'TL', ratio: 0.15 };
    const result = await runInference(crop, null);
    expect(result).toEqual({ class: 'clean', confidence: 1.0 });
  });
});

describe('logo_detector - detectLogos', () => {
  it('returns an empty array for no frames', async () => {
    const detections = await detectLogos([]);
    expect(detections).toEqual([]);
  });

  it('emits four detections per frame, one per corner, in TL/TR/BL/BR order', async () => {
    const frames = ['frame-a', 'frame-b'];
    const detections = await detectLogos(frames);

    expect(detections).toHaveLength(8);
    expect(detections.map((d) => d.corner)).toEqual([
      'TL', 'TR', 'BL', 'BR',
      'TL', 'TR', 'BL', 'BR'
    ]);
    expect(detections.map((d) => d.frame_index)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('returns detections with the expected shape', async () => {
    const detections = await detectLogos(['frame']);
    for (const d of detections) {
      expect(d).toEqual({
        frame_index: expect.any(Number),
        corner: expect.stringMatching(/^(TL|TR|BL|BR)$/),
        class: expect.any(String),
        confidence: expect.any(Number)
      });
    }
  });

  it('uses the stub inference by default and reports every crop as clean', async () => {
    const detections = await detectLogos(['frame-0', 'frame-1', 'frame-2']);
    for (const d of detections) {
      expect(d.class).toBe('clean');
      expect(d.confidence).toBe(1.0);
    }
  });

  it('supports injecting an alternate inference function for future ONNX swap', async () => {
    const infer = async (crop) => {
      if (crop.corner === 'BL') return { class: 'meta_sparkle', confidence: 0.92 };
      return { class: 'clean', confidence: 1.0 };
    };

    const detections = await detectLogos(['frame'], { infer });
    const bl = detections.find((d) => d.corner === 'BL');
    expect(bl.class).toBe('meta_sparkle');
    expect(bl.confidence).toBe(0.92);
  });

  it('passes both frame and corner descriptor into the inference function', async () => {
    const calls = [];
    const infer = async (crop, model) => {
      calls.push({ ...crop, model });
      return { class: 'clean', confidence: 1.0 };
    };

    const fakeModel = { ready: true, modelUrl: 'fake' };
    await detectLogos(['frame-x'], { infer, model: fakeModel });

    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({
      frame: 'frame-x',
      corner: 'TL',
      ratio: 0.15,
      model: fakeModel
    });
  });

  it('accepts binary buffers as frames without throwing', async () => {
    const buf = new Uint8Array([1, 2, 3]);
    const detections = await detectLogos([buf]);
    expect(detections).toHaveLength(4);
    expect(detections[0].class).toBe('clean');
  });
});
