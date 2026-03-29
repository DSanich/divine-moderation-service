import { describe, it, expect } from 'vitest';
import { buildLabelWebhookPayload } from './label-webhook.mjs';

describe('buildLabelWebhookPayload', () => {
  it('builds payload from quarantine result with scores', () => {
    const result = {
      sha256: 'abc123',
      action: 'QUARANTINE',
      scores: { nudity: 0.91, violence: 0.1 },
    };
    const payload = buildLabelWebhookPayload(result);
    expect(payload.sha256).toBe('abc123');
    expect(payload.action).toBe('QUARANTINE');
    expect(payload.labels).toEqual([{ category: 'nudity', score: 0.91 }]);
  });

  it('omits scores below threshold', () => {
    const result = {
      sha256: 'abc123',
      action: 'REVIEW',
      scores: { nudity: 0.3, violence: 0.1 },
    };
    const payload = buildLabelWebhookPayload(result);
    expect(payload.labels).toEqual([]);
  });

  it('includes multiple labels when multiple scores qualify', () => {
    const result = {
      sha256: 'abc123',
      action: 'QUARANTINE',
      scores: { nudity: 0.8, violence: 0.7, ai_generated: 0.9 },
    };
    const payload = buildLabelWebhookPayload(result);
    expect(payload.labels.length).toBe(3);
  });

  it('returns null for SAFE results', () => {
    const result = {
      sha256: 'abc123',
      action: 'SAFE',
      scores: { nudity: 0.1 },
    };
    const payload = buildLabelWebhookPayload(result);
    expect(payload).toBeNull();
  });

  it('builds payload from downstream signals even when action is SAFE', () => {
    const result = {
      sha256: 'abc123',
      action: 'SAFE',
      scores: { ai_generated: 0.97 },
      downstreamSignals: {
        hasSignals: true,
        scores: { nudity: 0.88, ai_generated: 0 }
      }
    };
    const payload = buildLabelWebhookPayload(result);
    expect(payload?.sha256).toBe('abc123');
    expect(payload?.action).toBe('SAFE');
    expect(payload?.labels).toEqual([{ category: 'nudity', score: 0.88 }]);
  });
});
