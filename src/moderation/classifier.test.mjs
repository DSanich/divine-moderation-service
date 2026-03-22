// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for content severity classification
// ABOUTME: Determines SAFE/REVIEW/QUARANTINE actions based on moderation scores

import { describe, it, expect } from 'vitest';
import { classifyModerationResult } from './classifier.mjs';

describe('Moderation Classifier', () => {
  it('should classify low scores as SAFE', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.1,
        violence: 0.05
      }
    });

    expect(result.action).toBe('SAFE');
    expect(result.severity).toBe('low');
    expect(result.reason).toContain('safe');
  });

  it('should classify medium scores as REVIEW', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.65,
        violence: 0.3
      }
    });

    expect(result.action).toBe('REVIEW');
    expect(result.severity).toBe('medium');
    expect(result.reason).toContain('review');
  });

  it('should classify scores above quarantine threshold as QUARANTINE', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.75,
        violence: 0.3
      }
    });

    expect(result.action).toBe('QUARANTINE');
    expect(result.severity).toBe('medium');
    expect(result.reason).toContain('quarantined');
  });

  it('should classify high nudity as AGE_RESTRICTED', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.85,
        violence: 0.1
      }
    });

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
    expect(result.reason).toContain('Adult');
  });

  it('should classify high violence as AGE_RESTRICTED', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.1,
        violence: 0.82
      }
    });

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
    expect(result.reason).toContain('Violent');
  });

  it('should use configurable thresholds from env', () => {
    const env = {
      NSFW_THRESHOLD_HIGH: '0.9',
      NSFW_THRESHOLD_MEDIUM: '0.7',
      VIOLENCE_THRESHOLD_HIGH: '0.9',
      VIOLENCE_THRESHOLD_MEDIUM: '0.7'
    };

    // Score 0.85: above default quarantine (0.7) but below env high (0.9) → QUARANTINE
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.85,
        violence: 0.1
      }
    }, env);

    expect(result.action).toBe('QUARANTINE');
  });

  it('should use configurable quarantine threshold from env', () => {
    const env = {
      QUARANTINE_THRESHOLD: '0.8'
    };

    // Score 0.75: above default medium (0.6) but below custom quarantine (0.8) → REVIEW
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.75,
        violence: 0.1
      }
    }, env);

    expect(result.action).toBe('REVIEW');
  });

  it('should use default thresholds when env not provided', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.85,
        violence: 0.1
      }
    });

    expect(result.action).toBe('AGE_RESTRICTED');
  });

  it('should include all scores in result', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.65,
        violence: 0.45,
        ai_generated: 0.2
      }
    });

    expect(result.scores.nudity).toBe(0.65);
    expect(result.scores.violence).toBe(0.45);
    expect(result.scores.ai_generated).toBe(0.2);
    expect(result.scores.gore).toBe(0);
    expect(result.scores.weapon).toBe(0);
    expect(Object.keys(result.scores).length).toBe(18);
  });

  it('should identify primary concern', () => {
    const nudityResult = classifyModerationResult({
      maxScores: {
        nudity: 0.85,
        violence: 0.1
      }
    });

    expect(nudityResult.primaryConcern).toBe('nudity');

    const violenceResult = classifyModerationResult({
      maxScores: {
        nudity: 0.1,
        violence: 0.85
      }
    });

    expect(violenceResult.primaryConcern).toBe('violence');
  });

  it('should handle flagged frames', () => {
    const flaggedFrames = [
      { position: 3, nudityScore: 0.95, reason: 'nudity' }
    ];

    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.95,
        violence: 0.1,
        ai_generated: 0.1
      },
      flaggedFrames
    });

    expect(result.flaggedFrames).toEqual(flaggedFrames);
  });

  it('should classify high AI-generated score as QUARANTINE pending secondary verification', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.1,
        violence: 0.1,
        ai_generated: 0.92
      }
    });

    expect(result.action).toBe('QUARANTINE');
    expect(result.severity).toBe('high');
    expect(result.category).toBe('ai_generated');
    expect(result.reason).toContain('AI-generated');
    expect(result.reason).toContain('secondary verification');
    expect(result.requiresSecondaryVerification).toBe(true);
  });

  it('should classify medium AI-generated score as REVIEW', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.1,
        violence: 0.1,
        ai_generated: 0.75
      }
    });

    expect(result.action).toBe('REVIEW');
    expect(result.severity).toBe('medium');
    expect(result.primaryConcern).toBe('ai_generated');
  });

  // New comprehensive category tests
  it('should classify self-harm as PERMANENT_BAN', () => {
    const result = classifyModerationResult({
      maxScores: {
        self_harm: 0.75,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('PERMANENT_BAN');
    expect(result.severity).toBe('critical');
    expect(result.category).toBe('self_harm');
  });

  it('should classify hate speech as PERMANENT_BAN', () => {
    const result = classifyModerationResult({
      maxScores: {
        offensive: 0.85,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('PERMANENT_BAN');
    expect(result.severity).toBe('critical');
    expect(result.category).toBe('hate_speech');
  });

  it('should classify extreme gore as PERMANENT_BAN', () => {
    const result = classifyModerationResult({
      maxScores: {
        gore: 0.96,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('PERMANENT_BAN');
    expect(result.severity).toBe('critical');
    expect(result.category).toBe('extreme_gore');
  });

  it('should classify high gore (< 0.95) as AGE_RESTRICTED', () => {
    const result = classifyModerationResult({
      maxScores: {
        gore: 0.85,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
  });

  it('should classify high weapon score as AGE_RESTRICTED', () => {
    const result = classifyModerationResult({
      maxScores: {
        weapon: 0.85,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
  });

  it('should classify high drug score as AGE_RESTRICTED', () => {
    const result = classifyModerationResult({
      maxScores: {
        recreational_drug: 0.85,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(result.severity).toBe('high');
  });

  it('should classify very high deepfake score as QUARANTINE pending secondary verification', () => {
    const result = classifyModerationResult({
      maxScores: {
        deepfake: 0.96,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('QUARANTINE');
    expect(result.severity).toBe('high');
    expect(result.category).toBe('deepfake');
    expect(result.requiresSecondaryVerification).toBe(true);
  });

  it('should classify medium deepfake score (0.85) as QUARANTINE not ban', () => {
    const result = classifyModerationResult({
      maxScores: {
        deepfake: 0.85,
        nudity: 0.1,
        violence: 0.1
      }
    });

    // Deepfake 0.85 is above quarantine threshold (0.7) but below deepfake high (0.95)
    expect(result.action).toBe('QUARANTINE');
    expect(result.severity).toBe('medium');
  });

  it('should classify medium offensive score as REVIEW', () => {
    const result = classifyModerationResult({
      maxScores: {
        offensive: 0.65,
        nudity: 0.1,
        violence: 0.1
      }
    });

    expect(result.action).toBe('REVIEW');
    expect(result.severity).toBe('medium');
  });

  it('should handle new maxScores format with all categories', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.1,
        violence: 0.2,
        gore: 0.15,
        offensive: 0.05,
        weapon: 0.3,
        self_harm: 0.05,
        recreational_drug: 0.1,
        alcohol: 0.2,
        tobacco: 0.1,
        medical: 0.05,
        gambling: 0.1,
        money: 0.05,
        destruction: 0.15,
        military: 0.1,
        ai_generated: 0.2,
        deepfake: 0.1,
        text_profanity: 0.05,
        qr_unsafe: 0.05
      }
    });

    expect(result.action).toBe('SAFE');
    expect(result.scores).toBeDefined();
    expect(Object.keys(result.scores).length).toBeGreaterThan(10);
  });

  it('should prioritize self-harm over other high scores', () => {
    const result = classifyModerationResult({
      maxScores: {
        self_harm: 0.75,
        nudity: 0.9,  // Even though nudity is higher
        violence: 0.85
      }
    });

    expect(result.action).toBe('PERMANENT_BAN');
    expect(result.category).toBe('self_harm');
  });

  it('should use informational category thresholds for REVIEW', () => {
    const result = classifyModerationResult({
      maxScores: {
        medical: 0.65,  // Informational category — between medium (0.6) and quarantine (0.7)
        military: 0.6,
        text_profanity: 0.65
      }
    });

    expect(result.action).toBe('REVIEW');
    expect(result.severity).toBe('medium');
  });

  it('should quarantine informational categories above quarantine threshold', () => {
    const result = classifyModerationResult({
      maxScores: {
        text_profanity: 0.75  // Above quarantine threshold (0.7) but below high (0.8)
      }
    });

    expect(result.action).toBe('QUARANTINE');
    expect(result.severity).toBe('medium');
  });

  it('should include all scores in result for new format', () => {
    const result = classifyModerationResult({
      maxScores: {
        nudity: 0.2,
        violence: 0.15,
        gore: 0.1,
        weapon: 0.3,
        deepfake: 0.25
      }
    });

    expect(result.scores.nudity).toBe(0.2);
    expect(result.scores.violence).toBe(0.15);
    expect(result.scores.gore).toBe(0.1);
    expect(result.scores.weapon).toBe(0.3);
    expect(result.scores.deepfake).toBe(0.25);
  });
});
