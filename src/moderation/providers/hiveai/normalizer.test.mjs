// ABOUTME: Tests for Hive.AI response normalization
// ABOUTME: Verifies conversion from Hive.AI V3 format to Divine's standard schema

import { describe, it, expect } from 'vitest';
import { normalizeHiveAIResponse } from './normalizer.mjs';

describe('Hive.AI Response Normalizer', () => {
  it('should normalize AI-generated detection response', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'ai_generated', score: 0.95 },
                { class: 'midjourney', score: 0.88 }
              ]
            },
            {
              time: 3,
              classes: [
                { class: 'ai_generated', score: 0.92 },
                { class: 'stable_diffusion', score: 0.85 }
              ]
            }
          ]
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.scores.ai_generated).toBe(0.95);
    expect(result.details.ai_generated.totalFrames).toBe(2);
    expect(result.details.ai_generated.framesDetected).toBe(2); // Both exceed 0.9 threshold
    expect(result.details.ai_generated.detectedSource).toBe('midjourney');
    expect(result.details.ai_generated.sourceConfidence).toBe(0.88);
  });

  it('should detect deepfakes with consecutive frames', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [{ class: 'deepfake', score: 0.6 }]
            },
            {
              time: 1,
              classes: [{ class: 'deepfake', score: 0.7 }]
            },
            {
              time: 2,
              classes: [{ class: 'deepfake', score: 0.3 }]
            }
          ]
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.scores.deepfake).toBe(0.7);
    expect(result.details.deepfake.consecutiveFrames).toBe(2);
    expect(result.details.deepfake.framesDetected).toBe(2);
  });

  it('should apply 5% threshold for deepfake detection', () => {
    // Create 100 frames with 5 deepfake detections (5%)
    const frames = Array.from({ length: 100 }, (_, i) => ({
      time: i,
      classes: [
        { class: 'deepfake', score: i < 5 ? 0.6 : 0.2 }
      ]
    }));

    const hiveResponse = {
      status: [{
        response: {
          output: frames
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.details.deepfake.totalFrames).toBe(100);
    expect(result.details.deepfake.framesDetected).toBe(5);
    // 5/100 = 5% exactly
    expect(result.details.deepfake.framesDetected / result.details.deepfake.totalFrames).toBe(0.05);
  });

  it('should flag frames exceeding AI-generated threshold (0.9)', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [{ class: 'ai_generated', score: 0.95 }]
            },
            {
              time: 3,
              classes: [{ class: 'ai_generated', score: 0.85 }] // Below threshold
            },
            {
              time: 6,
              classes: [{ class: 'ai_generated', score: 0.92 }]
            }
          ]
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.flaggedFrames).toHaveLength(2);
    expect(result.flaggedFrames[0].position).toBe(0);
    expect(result.flaggedFrames[0].primaryConcern).toBe('ai_generated');
    expect(result.flaggedFrames[1].position).toBe(6);
  });

  it('should handle not_ai_generated classification', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'not_ai_generated', score: 0.98 },
                { class: 'none', score: 0.95 }
              ]
            }
          ]
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    // not_ai_generated with high confidence means low AI score
    expect(result.scores.ai_generated).toBeLessThan(0.1);
    expect(result.details.ai_generated.framesDetected).toBe(0);
    expect(result.flaggedFrames).toHaveLength(0);
  });

  it('should handle empty response', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: []
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.scores.ai_generated).toBe(0);
    expect(result.scores.deepfake).toBe(0);
    expect(result.details.ai_generated.totalFrames).toBe(0);
    expect(result.flaggedFrames).toHaveLength(0);
  });

  it('should handle missing status array', () => {
    const hiveResponse = {};

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.scores).toBeDefined();
    expect(result.details).toBeDefined();
    expect(result.flaggedFrames).toHaveLength(0);
  });

  it('should identify highest confidence source', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'ai_generated', score: 0.95 },
                { class: 'dall_e', score: 0.6 },
                { class: 'midjourney', score: 0.88 },
                { class: 'stable_diffusion', score: 0.72 }
              ]
            }
          ]
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.details.ai_generated.detectedSource).toBe('midjourney');
    expect(result.details.ai_generated.sourceConfidence).toBe(0.88);
  });

  it('should ignore inconclusive and none classifications for source', () => {
    const hiveResponse = {
      status: [{
        response: {
          output: [
            {
              time: 0,
              classes: [
                { class: 'ai_generated', score: 0.95 },
                { class: 'none', score: 0.7 },
                { class: 'inconclusive', score: 0.5 }
              ]
            }
          ]
        }
      }]
    };

    const result = normalizeHiveAIResponse(hiveResponse);

    expect(result.details.ai_generated.detectedSource).toBeNull();
  });
});
