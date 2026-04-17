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
  LOGO_CLASSES,
  CORNERS
} from './logo_detector.mjs';

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
