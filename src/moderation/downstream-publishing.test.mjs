// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for downstream moderation publishing decisions
// ABOUTME: Verifies serveable SAFE results can still emit filtered moderation context

import { describe, expect, it } from 'vitest';
import { buildDownstreamPublishContext } from './downstream-publishing.mjs';

describe('buildDownstreamPublishContext', () => {
  it('builds review-context publishing data for SAFE original vines with non-AI signals', () => {
    const result = {
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      category: null,
      reason: 'Original Vine archive content remains serveable',
      severity: 'low',
      cdnUrl: 'https://media.divine.video/' + 'a'.repeat(64),
      flaggedFrames: [],
      scores: { nudity: 0.88, ai_generated: 0.97 },
      downstreamSignals: {
        hasSignals: true,
        scores: { nudity: 0.88, ai_generated: 0 },
        primaryConcern: 'nudity',
        category: 'nudity',
        severity: 'high',
        reason: 'Moderation signal retained for nudity'
      }
    };

    const context = buildDownstreamPublishContext(result);

    expect(context.publishReport).toBe(true);
    expect(context.reportData).toMatchObject({
      type: 'review',
      category: 'nudity',
      severity: 'high',
      scores: { nudity: 0.88, ai_generated: 0 }
    });
    expect(context.labelResult.scores).toEqual({ nudity: 0.88, ai_generated: 0 });
  });

  it('suppresses publishing for SAFE original vines with AI-only archive signals', () => {
    const result = {
      sha256: 'b'.repeat(64),
      action: 'SAFE',
      reason: 'Original Vine archive content remains serveable',
      severity: 'low',
      scores: { ai_generated: 0.97 },
      downstreamSignals: {
        hasSignals: false,
        scores: { ai_generated: 0 },
        primaryConcern: null,
        category: null,
        severity: 'low',
        reason: null
      }
    };

    const context = buildDownstreamPublishContext(result);

    expect(context.publishReport).toBe(false);
    expect(context.reportData).toBeNull();
    expect(context.labelResult.scores).toEqual({ ai_generated: 0 });
  });
});
