// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Video Seal watermark payload interpretation
// ABOUTME: Verifies prefix decoding, confidence thresholds, and unknown payload handling

import { describe, it, expect } from 'vitest';
import { interpretVideoSealPayload } from './videoseal.mjs';

describe('interpretVideoSealPayload', () => {
  const divinePayload = `01${'a'.repeat(62)}`;

  it('returns not detected when payload is null', () => {
    expect(interpretVideoSealPayload(null, 1)).toEqual({
      signal: 'videoseal',
      detected: false,
      confidence: 0
    });
  });

  it('returns not detected when bit accuracy is below threshold', () => {
    expect(interpretVideoSealPayload(divinePayload, 0.8499)).toEqual({
      signal: 'videoseal',
      detected: false,
      confidence: 0
    });
  });

  it('interprets the known divine prefix', () => {
    expect(interpretVideoSealPayload(divinePayload, 0.9)).toEqual({
      signal: 'videoseal',
      detected: true,
      source: 'divine',
      isAI: false,
      payload: divinePayload,
      confidence: 0.9
    });
  });

  it('flags unknown prefixes for research', () => {
    const payload = `ff${'b'.repeat(62)}`;

    expect(interpretVideoSealPayload(payload, 0.91)).toMatchObject({
      signal: 'videoseal',
      detected: true,
      source: 'unknown',
      isAI: null,
      action: 'flag_for_research',
      payload
    });
  });

  it('treats 0.85 and 1.0 as valid bit accuracy boundaries', () => {
    expect(interpretVideoSealPayload(divinePayload, 0.85)).toMatchObject({
      detected: true,
      confidence: 0.85
    });

    expect(interpretVideoSealPayload(divinePayload, 1)).toMatchObject({
      detected: true,
      confidence: 1
    });
  });
});
