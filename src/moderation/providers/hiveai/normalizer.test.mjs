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

  describe('Raw Classifier Data Extraction', () => {
    it('should include rawClassifierData in normalized output', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 0,
                  classes: [
                    { class: 'yes_female_nudity', score: 0.85 },
                    { class: 'general_nsfw', score: 0.92 },
                    { class: 'no_nudity', score: 0.08 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.rawClassifierData).toBeDefined();
      expect(result.rawClassifierData.extractedAt).toBeDefined();
      expect(result.rawClassifierData.moderation).toBeDefined();
      expect(result.rawClassifierData.aiDetection).toBeNull();
    });

    it('should capture ALL classes per frame including unmapped ones', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                {
                  time: 2.5,
                  classes: [
                    { class: 'yes_female_nudity', score: 0.85 },
                    { class: 'no_nudity', score: 0.15 },
                    { class: 'general_nsfw', score: 0.92 },
                    { class: 'general_suggestive', score: 0.45 },
                    { class: 'general_safe', score: 0.05 }
                  ]
                }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);
      const modFrames = result.rawClassifierData.moderation.frames;

      expect(modFrames).toHaveLength(1);
      expect(modFrames[0].timestamp).toBe(2.5);
      expect(modFrames[0].source).toBe('moderation');

      // ALL classes should be present, including ones NOT in MODERATION_CLASS_MAP
      expect(modFrames[0].scores['yes_female_nudity']).toBe(0.85);
      expect(modFrames[0].scores['no_nudity']).toBe(0.15);
      expect(modFrames[0].scores['general_nsfw']).toBe(0.92);
      expect(modFrames[0].scores['general_suggestive']).toBe(0.45);
      expect(modFrames[0].scores['general_safe']).toBe(0.05);
    });

    it('should track max scores across all frames per class', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                { time: 0, classes: [{ class: 'yes_violence', score: 0.3 }, { class: 'yes_blood_shed', score: 0.1 }] },
                { time: 3, classes: [{ class: 'yes_violence', score: 0.9 }, { class: 'yes_blood_shed', score: 0.6 }] },
                { time: 6, classes: [{ class: 'yes_violence', score: 0.5 }, { class: 'yes_blood_shed', score: 0.2 }] }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);
      const maxScores = result.rawClassifierData.allClassMaxScores;

      expect(maxScores['yes_violence']).toBe(0.9);
      expect(maxScores['yes_blood_shed']).toBe(0.6);
    });

    it('should capture per-frame data with timestamps for temporal analysis', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                { time: 0, classes: [{ class: 'yes_violence', score: 0.3 }] },
                { time: 3.5, classes: [{ class: 'yes_violence', score: 0.9 }] },
                { time: 7.0, classes: [{ class: 'yes_violence', score: 0.1 }] }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);
      const frames = result.rawClassifierData.moderation.frames;

      expect(frames).toHaveLength(3);
      expect(frames[0].timestamp).toBe(0);
      expect(frames[1].timestamp).toBe(3.5);
      expect(frames[2].timestamp).toBe(7.0);

      // Each frame has its own scores
      expect(frames[0].scores['yes_violence']).toBe(0.3);
      expect(frames[1].scores['yes_violence']).toBe(0.9);
      expect(frames[2].scores['yes_violence']).toBe(0.1);
    });

    it('should capture both moderation and AI detection raw data', () => {
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
                    { class: 'not_ai_generated', score: 0.08 },
                    { class: 'midjourney', score: 0.85 },
                    { class: 'stable_diffusion', score: 0.12 }
                  ]
                }
              ]
            }
          }]
        }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      // Both moderation and AI detection data should be captured
      expect(result.rawClassifierData.moderation).toBeDefined();
      expect(result.rawClassifierData.aiDetection).toBeDefined();

      // Moderation frame data
      expect(result.rawClassifierData.moderation.frames[0].scores['yes_female_nudity']).toBe(0.8);

      // AI detection frame data
      expect(result.rawClassifierData.aiDetection.frames[0].scores['ai_generated']).toBe(0.92);
      expect(result.rawClassifierData.aiDetection.frames[0].scores['not_ai_generated']).toBe(0.08);
      expect(result.rawClassifierData.aiDetection.frames[0].scores['midjourney']).toBe(0.85);
      expect(result.rawClassifierData.aiDetection.frames[0].scores['stable_diffusion']).toBe(0.12);

      // AI detection classes should be prefixed in allClassMaxScores
      expect(result.rawClassifierData.allClassMaxScores['ai_detection:ai_generated']).toBe(0.92);
      expect(result.rawClassifierData.allClassMaxScores['ai_detection:midjourney']).toBe(0.85);

      // Moderation classes should be in allClassMaxScores without prefix
      expect(result.rawClassifierData.allClassMaxScores['yes_female_nudity']).toBe(0.8);
    });

    it('should return null moderation/aiDetection when inputs are null', () => {
      const hiveResponse = {
        moderation: null,
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      expect(result.rawClassifierData).toBeDefined();
      expect(result.rawClassifierData.moderation).toBeNull();
      expect(result.rawClassifierData.aiDetection).toBeNull();
      expect(result.rawClassifierData.allClassMaxScores).toEqual({});
    });

    it('should handle empty output arrays in rawClassifierData', () => {
      const hiveResponse = {
        moderation: { status: [{ response: { output: [] } }] },
        aiDetection: { status: [{ response: { output: [] } }] }
      };

      const result = normalizeHiveAIResponse(hiveResponse);

      // Empty outputs should result in null rawClassifierData for each model
      // (extractRawClassifierData is only called when output.length > 0)
      expect(result.rawClassifierData.moderation).toBeNull();
      expect(result.rawClassifierData.aiDetection).toBeNull();
    });

    it('should use frame index as timestamp when time is not provided', () => {
      const hiveResponse = {
        moderation: {
          status: [{
            response: {
              output: [
                { classes: [{ class: 'yes_violence', score: 0.5 }] },
                { classes: [{ class: 'yes_violence', score: 0.7 }] }
              ]
            }
          }]
        },
        aiDetection: null
      };

      const result = normalizeHiveAIResponse(hiveResponse);
      const frames = result.rawClassifierData.moderation.frames;

      expect(frames[0].timestamp).toBe(0);
      expect(frames[1].timestamp).toBe(1);
    });
  });
});
