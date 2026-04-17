// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the per-signal cutover mode dispatcher
// ABOUTME: Covers shadow | gated | preferred | sole plus env resolution

import { describe, it, expect, vi } from 'vitest';
import {
  dispatchSignal,
  readMode,
  readGate,
  MODES,
  DEFAULT_MODE,
  DEFAULT_GATE
} from './ai-detector-mode.mjs';

const INTERNAL_DETECTED = {
  state: 'detected', class: 'meta_sparkle', confidence: 0.92,
  frames_flagged: 3, total_frames: 4, model: 'logo-v1'
};
const INTERNAL_ABSENT = {
  state: 'absent', confidence: 0.1, total_frames: 4, model: 'logo-v1'
};
const INTERNAL_ERROR = {
  state: 'error', error: 'model crashed', model: 'logo-v1'
};
const INTERNAL_LOW_CONF = {
  state: 'detected', class: 'meta_sparkle', confidence: 0.5,
  frames_flagged: 2, total_frames: 4, model: 'logo-v1'
};

const VENDOR_VERDICT = { detected: true, ai_generated: 0.91, provider: 'hive' };

describe('ai-detector-mode - constants', () => {
  it('exposes the four spec-defined modes', () => {
    expect(MODES).toEqual(['shadow', 'gated', 'preferred', 'sole']);
  });

  it('defaults mode to shadow', () => {
    expect(DEFAULT_MODE).toBe('shadow');
  });

  it('defaults gate to 0.8 per spec (Hive-equivalent high threshold)', () => {
    expect(DEFAULT_GATE).toBe(0.8);
  });
});

describe('ai-detector-mode - readMode', () => {
  it('reads AI_DETECTOR_MODE_<SIGNAL> (upper-cased)', () => {
    expect(readMode({ AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'preferred' }, 'watermark_visible'))
      .toBe('preferred');
  });

  it('accepts mixed-case env values', () => {
    expect(readMode({ AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'Gated' }, 'watermark_visible'))
      .toBe('gated');
  });

  it('defaults to shadow when the env var is missing', () => {
    expect(readMode({}, 'watermark_visible')).toBe('shadow');
  });

  it('defaults to shadow for unknown mode values', () => {
    expect(readMode({ AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'yolo' }, 'watermark_visible'))
      .toBe('shadow');
  });
});

describe('ai-detector-mode - readGate', () => {
  it('reads AI_DETECTOR_GATE_<SIGNAL> as a number', () => {
    expect(readGate({ AI_DETECTOR_GATE_WATERMARK_VISIBLE: '0.9' }, 'watermark_visible'))
      .toBe(0.9);
  });

  it('defaults to 0.8 when the env var is missing', () => {
    expect(readGate({}, 'watermark_visible')).toBe(0.8);
  });

  it('defaults to 0.8 when the env var is not a number', () => {
    expect(readGate({ AI_DETECTOR_GATE_WATERMARK_VISIBLE: 'nope' }, 'watermark_visible'))
      .toBe(0.8);
  });

  it('defaults to 0.8 when the env var is outside 0..1', () => {
    expect(readGate({ AI_DETECTOR_GATE_WATERMARK_VISIBLE: '1.5' }, 'watermark_visible'))
      .toBe(0.8);
    expect(readGate({ AI_DETECTOR_GATE_WATERMARK_VISIBLE: '-0.1' }, 'watermark_visible'))
      .toBe(0.8);
  });
});

describe('ai-detector-mode - dispatchSignal: shadow', () => {
  it('calls vendor and returns vendor verdict but passes internal to the logger', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const log = vi.fn();
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED,
      callVendor,
      env: {}, // default mode = shadow
      log
    });

    expect(callVendor).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      verdict: VENDOR_VERDICT,
      source: 'vendor',
      mode: 'shadow'
    }));
    expect(log).toHaveBeenCalledWith('ai-detector.shadow', expect.objectContaining({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED,
      vendor: VENDOR_VERDICT,
      disagreement: expect.any(Boolean)
    }));
  });

  it('flags disagreement when internal detects but vendor does not', async () => {
    const callVendor = vi.fn(async () => ({ detected: false, ai_generated: 0.1 }));
    const log = vi.fn();
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'shadow' },
      log
    });
    expect(result.disagreement).toBe(true);
  });

  it('does not flag disagreement when both agree on detection', async () => {
    const callVendor = vi.fn(async () => ({ detected: true, ai_generated: 0.9 }));
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED,
      callVendor,
      env: {}
    });
    expect(result.disagreement).toBe(false);
  });
});

describe('ai-detector-mode - dispatchSignal: gated', () => {
  it('uses internal when confidence >= gate', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED, // confidence 0.92, gate default 0.8
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'gated' }
    });
    expect(result.source).toBe('internal');
    expect(result.verdict).toBe(INTERNAL_DETECTED);
    expect(callVendor).not.toHaveBeenCalled();
  });

  it('falls through to vendor when confidence < gate', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_LOW_CONF, // confidence 0.5
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'gated' }
    });
    expect(result.source).toBe('vendor');
    expect(callVendor).toHaveBeenCalledTimes(1);
  });

  it('falls through to vendor when internal errored', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_ERROR,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'gated' }
    });
    expect(result.source).toBe('vendor');
  });

  it('honors a custom gate from AI_DETECTOR_GATE_<SIGNAL>', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    // Low-conf 0.5 passes a gate of 0.4 but not the 0.8 default.
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_LOW_CONF,
      callVendor,
      env: {
        AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'gated',
        AI_DETECTOR_GATE_WATERMARK_VISIBLE: '0.4'
      }
    });
    expect(result.source).toBe('internal');
    expect(callVendor).not.toHaveBeenCalled();
  });
});

describe('ai-detector-mode - dispatchSignal: preferred', () => {
  it('uses internal when state != error, regardless of confidence', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_LOW_CONF,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'preferred' }
    });
    expect(result.source).toBe('internal');
    expect(callVendor).not.toHaveBeenCalled();
  });

  it('uses internal when state is absent', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_ABSENT,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'preferred' }
    });
    expect(result.source).toBe('internal');
  });

  it('falls through to vendor on error state', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_ERROR,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'preferred' }
    });
    expect(result.source).toBe('vendor');
    expect(callVendor).toHaveBeenCalledTimes(1);
  });
});

describe('ai-detector-mode - dispatchSignal: sole', () => {
  it('never calls vendor, even on internal error', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_ERROR,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'sole' }
    });
    expect(result.source).toBe('internal');
    expect(result.verdict).toBe(INTERNAL_ERROR);
    expect(callVendor).not.toHaveBeenCalled();
  });

  it('returns internal on detected', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED,
      callVendor,
      env: { AI_DETECTOR_MODE_WATERMARK_VISIBLE: 'sole' }
    });
    expect(result.source).toBe('internal');
    expect(result.verdict).toBe(INTERNAL_DETECTED);
    expect(callVendor).not.toHaveBeenCalled();
  });
});

describe('ai-detector-mode - dispatchSignal: default mode', () => {
  it('defaults to shadow when env is empty (no behavior change without rollout)', async () => {
    const callVendor = vi.fn(async () => VENDOR_VERDICT);
    const result = await dispatchSignal({
      signal: 'watermark_visible',
      internal: INTERNAL_DETECTED,
      callVendor,
      env: {}
    });
    expect(result.mode).toBe('shadow');
    expect(result.source).toBe('vendor');
    expect(callVendor).toHaveBeenCalledTimes(1);
  });
});
