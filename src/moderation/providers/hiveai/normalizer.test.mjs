// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Hive.AI response normalization
// ABOUTME: Verifies conversion from Hive.AI combined responses to Divine's standard schema

import { describe, it, expect } from 'vitest';
import { normalizeHiveAIResponse } from './normalizer.mjs';

describe('Hive.AI Response Normalizer', () => {
  describe('AI Detection Normalization', () => {
    it('should normalize AI-generated detection response', () => {
      const hiveResponse = {
        moderation: null,
        aiDetection: {
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
        }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.ai_generated).toBe(0.95);
      expect(result.details.ai_generated.totalFrames).toBe(2);
      expect(result.details.ai_generated.framesDetected).toBe(2);
      expect(result.details.ai_generated.detectedSource).toBe('midjourney');
      expect(result.details.ai_generated.sourceConfidence).toBe(0.88);
    });

    it('should detect deepfakes with consecutive frames', () => {
      const hiveResponse = {
        moderation: null,
        aiDetection: {
          status: [{
            response: {
              output: [
                { time: 0, classes: [{ class: 'deepfake', score: 0.6 }] },
                { time: 1, classes: [{ class: 'deepfake', score: 0.7 }] },
                { time: 2, classes: [{ class: 'deepfake', score: 0.3 }] }
              ]
            }
          }]
        }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.deepfake).toBe(0.7);
      expect(result.details.deepfake.consecutiveFrames).toBe(2);
      expect(result.details.deepfake.framesDetected).toBe(2);
    });

    it('should handle not_ai_generated classification', () => {
      const hiveResponse = {
        moderation: null,
        aiDetection: {
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
        }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.ai_generated).toBeLessThan(0.1);
      expect(result.details.ai_generated.framesDetected).toBe(0);
    });
  });

  describe('Content Moderation Normalization', () => {
    it('should normalize nudity detection', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_female_nudity', score: 0.85 },
                    { class: 'general_nsfw', score: 0.92 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.nudity).toBe(0.92);
    });

    it('should normalize violence and gore detection', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_violence', score: 0.75 },
                    { class: 'yes_blood_shed', score: 0.82 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.violence).toBe(0.75);
      expect(result.scores.gore).toBe(0.82);
    });

    it('should normalize weapons detection', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_firearm', score: 0.88 },
                    { class: 'yes_knife', score: 0.45 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.weapons).toBe(0.88);
    });

    it('should normalize substances detection', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_drugs', score: 0.7 },
                    { class: 'yes_alcohol', score: 0.9 },
                    { class: 'yes_smoking', score: 0.65 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.drugs).toBe(0.7);
      expect(result.scores.alcohol).toBe(0.9);
      expect(result.scores.tobacco).toBe(0.65);
    });

    it('should normalize offensive content detection', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_nazi', score: 0.95 },
                    { class: 'yes_middle_finger', score: 0.75 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.offensive).toBe(0.95);
    });
  });

  describe('Combined Results', () => {
    it('should merge moderation and AI detection results', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_female_nudity', score: 0.8 },
                    { class: 'yes_violence', score: 0.3 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'ai_generated', score: 0.92 },
                    { class: 'midjourney', score: 0.85 }
                  ]
                }
              ]
            }
          }]
        }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      // Content moderation scores
      expect(result.scores.nudity).toBe(0.8);
      expect(result.scores.violence).toBe(0.3);

      // AI detection scores
      expect(result.scores.ai_generated).toBe(0.92);
      expect(result.details.ai_generated.detectedSource).toBe('midjourney');
    });

    it('should flag frames from both models', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [{ class: 'yes_female_nudity', score: 0.85 }]
                }
              ]
            }
          }]
        },
        aiDetection: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [{ class: 'ai_generated', score: 0.95 }]
                }
              ]
            }
          }]
        }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.flaggedFrames.length).toBeGreaterThanOrEqual(2);

      const moderationFlag = result.flaggedFrames.find(f => f.source === 'moderation');
      const aiFlag = result.flaggedFrames.find(f => f.source === 'ai_detection');

      expect(moderationFlag).toBeDefined();
      expect(aiFlag).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty responses', () => {
      const hiveResponse = {
        moderation: { status: [{ response: { output: [] } }] },
        aiDetection: { status: [{ response: { output: [] } }] }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.nudity).toBe(0);
      expect(result.scores.ai_generated).toBe(0);
      expect(result.flaggedFrames).toHaveLength(0);
    });

    it('should handle null responses', () => {
      const hiveResponse = {
        moderation: null,
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.flaggedFrames).toHaveLength(0);
    });

    it('should handle missing status array', () => {
      const hiveResponse = {
        moderation: {},
        aiDetection: {}
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores).toBeDefined();
      expect(result.flaggedFrames).toHaveLength(0);
    });

    it('should take max score across all frames', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                { time: 0, classes: [{ class: 'yes_violence', score: 0.3 }] },
                { time: 3, classes: [{ class: 'yes_violence', score: 0.9 }] },
                { time: 6, classes: [{ class: 'yes_violence', score: 0.5 }] }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.scores.violence).toBe(0.9);
    });
  });
});
