// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Normalizes Hive.AI responses (moderation + AI detection) to standard format
// ABOUTME: Merges results from both models into Divine's unified schema

/**
 * Hive.AI moderation class mappings to our standard categories
 * Based on Hive.AI Visual Moderation model output classes
 */
const MODERATION_CLASS_MAP = {
  // Nudity/Sexual
  'general_nsfw': 'nudity',
  'general_suggestive': 'nudity',
  'yes_sexual_activity': 'nudity',
  'yes_sexual_display': 'nudity',
  'yes_female_nudity': 'nudity',
  'yes_male_nudity': 'nudity',
  'yes_sheer_see-through': 'nudity',
  'yes_sex_toy': 'nudity',
  'yes_male_underwear': 'nudity',
  'yes_female_underwear': 'nudity',
  'yes_female_swimwear': 'nudity',
  'yes_male_swimwear': 'nudity',
  'animated_explicit_sexual_content': 'nudity',
  'animated_female_nudity': 'nudity',
  'animated_male_nudity': 'nudity',
  'animated_suggestive': 'nudity',

  // Violence
  'yes_violence': 'violence',
  'yes_self-harm': 'selfHarm',
  'yes_blood_shed': 'gore',
  'yes_corpse': 'gore',
  'yes_serious_injury': 'gore',
  'animated_violence': 'violence',
  'animated_blood': 'gore',

  // Weapons
  'yes_weapon': 'weapons',
  'yes_firearm': 'weapons',
  'yes_knife': 'weapons',
  'animated_weapon': 'weapons',

  // Drugs/Substances
  'yes_drugs': 'drugs',
  'yes_pills': 'drugs',
  'yes_drug_paraphernalia': 'drugs',
  'yes_alcohol': 'alcohol',
  'yes_tobacco': 'tobacco',
  'yes_smoking': 'tobacco',

  // Gambling
  'yes_gambling': 'gambling',

  // Hate/Offensive
  'yes_nazi': 'offensive',
  'yes_confederate': 'offensive',
  'yes_supremacist': 'offensive',
  'yes_terrorist': 'offensive',
  'yes_middle_finger': 'offensive',
  'animated_hate_symbol': 'offensive'
};

/**
 * Normalize Hive.AI moderation response (content safety model)
 * @param {Object} moderationResult - Raw moderation API response
 * @returns {Object} Partial scores object
 */
function normalizeModerationResponse(moderationResult) {
  const scores = {
    nudity: 0,
    violence: 0,
    gore: 0,
    offensive: 0,
    weapons: 0,
    drugs: 0,
    alcohol: 0,
    tobacco: 0,
    gambling: 0,
    selfHarm: 0
  };

  const details = {};
  const flaggedFrames = [];

  if (!moderationResult?.status?.[0]?.response?.output) {
    console.warn('[HiveAI] No moderation output data');
    return { scores, details, flaggedFrames };
  }

  const output = moderationResult.status[0].response.output;

  for (let i = 0; i < output.length; i++) {
    const frame = output[i];
    const classes = frame.classes || [];
    const frameScores = { ...scores };

    for (const cls of classes) {
      const className = cls.class?.toLowerCase();
      const score = parseFloat(cls.score) || 0;
      const category = MODERATION_CLASS_MAP[className];

      if (category && score > frameScores[category]) {
        frameScores[category] = score;
      }
    }

    // Update max scores
    for (const [category, score] of Object.entries(frameScores)) {
      if (score > scores[category]) {
        scores[category] = score;
      }
    }

    // Flag frames with high scores
    const maxScore = Math.max(...Object.values(frameScores));
    if (maxScore >= 0.5) {
      const primaryConcern = Object.entries(frameScores)
        .sort((a, b) => b[1] - a[1])[0][0];

      flaggedFrames.push({
        position: frame.time || i,
        primaryConcern,
        primaryScore: maxScore,
        scores: frameScores,
        source: 'moderation'
      });
    }
  }

  console.log(`[HiveAI] Moderation scores - nudity: ${scores.nudity.toFixed(3)}, violence: ${scores.violence.toFixed(3)}, weapons: ${scores.weapons.toFixed(3)}`);

  return { scores, details, flaggedFrames };
}

/**
 * Normalize Hive.AI AI detection response (AI-generated/deepfake model)
 * @param {Object} aiResult - Raw AI detection API response
 * @returns {Object} Partial scores object with ai_generated and deepfake
 */
function normalizeAIDetectionResponse(aiResult) {
  const scores = {
    ai_generated: 0,
    deepfake: 0
  };

  const details = {
    ai_generated: {
      maxScore: 0,
      detectedSource: null,
      sourceConfidence: 0,
      framesDetected: 0,
      totalFrames: 0
    },
    deepfake: {
      maxScore: 0,
      consecutiveFrames: 0,
      framesDetected: 0,
      totalFrames: 0
    }
  };

  const flaggedFrames = [];

  if (!aiResult?.status?.[0]?.response?.output) {
    console.warn('[HiveAI] No AI detection output data');
    return { scores, details, flaggedFrames };
  }

  const output = aiResult.status[0].response.output;
  details.ai_generated.totalFrames = output.length;
  details.deepfake.totalFrames = output.length;

  let consecutiveDeepfakeCount = 0;
  let maxConsecutiveDeepfake = 0;

  for (let i = 0; i < output.length; i++) {
    const frame = output[i];
    const classes = frame.classes || [];

    let frameAIScore = 0;
    let frameDeepfakeScore = 0;
    let detectedSource = null;
    let sourceScore = 0;

    for (const cls of classes) {
      const className = cls.class?.toLowerCase();
      const score = parseFloat(cls.score) || 0;

      if (className === 'ai_generated') {
        frameAIScore = score;
      } else if (className === 'not_ai_generated') {
        frameAIScore = Math.max(frameAIScore, 1 - score);
      } else if (className === 'deepfake') {
        frameDeepfakeScore = score;
      } else if (className !== 'none' && className !== 'inconclusive' && className !== 'not_deepfake') {
        // Source classification (dall_e, midjourney, etc.)
        if (score > sourceScore) {
          detectedSource = className;
          sourceScore = score;
        }
      }
    }

    scores.ai_generated = Math.max(scores.ai_generated, frameAIScore);
    scores.deepfake = Math.max(scores.deepfake, frameDeepfakeScore);

    if (detectedSource && sourceScore > details.ai_generated.sourceConfidence) {
      details.ai_generated.detectedSource = detectedSource;
      details.ai_generated.sourceConfidence = sourceScore;
    }

    if (frameAIScore >= 0.9) {
      details.ai_generated.framesDetected++;
      details.ai_generated.maxScore = Math.max(details.ai_generated.maxScore, frameAIScore);
    }

    if (frameDeepfakeScore >= 0.5) {
      consecutiveDeepfakeCount++;
      maxConsecutiveDeepfake = Math.max(maxConsecutiveDeepfake, consecutiveDeepfakeCount);
      details.deepfake.framesDetected++;
      details.deepfake.maxScore = Math.max(details.deepfake.maxScore, frameDeepfakeScore);
    } else {
      consecutiveDeepfakeCount = 0;
    }

    if (frameAIScore >= 0.9 || frameDeepfakeScore >= 0.5) {
      flaggedFrames.push({
        position: frame.time || i,
        primaryConcern: frameAIScore >= 0.9 ? 'ai_generated' : 'deepfake',
        primaryScore: Math.max(frameAIScore, frameDeepfakeScore),
        scores: { ai_generated: frameAIScore, deepfake: frameDeepfakeScore },
        detectedSource,
        sourceConfidence: sourceScore,
        source: 'ai_detection'
      });
    }
  }

  details.deepfake.consecutiveFrames = maxConsecutiveDeepfake;

  const deepfakePercentage = details.deepfake.totalFrames > 0
    ? (details.deepfake.framesDetected / details.deepfake.totalFrames)
    : 0;

  const isAIGenerated = scores.ai_generated >= 0.9;
  const isDeepfake = (maxConsecutiveDeepfake >= 2 && scores.deepfake >= 0.5) || deepfakePercentage >= 0.05;

  console.log(`[HiveAI] AI-Generated: ${isAIGenerated} (max: ${scores.ai_generated.toFixed(3)})`);
  console.log(`[HiveAI] Deepfake: ${isDeepfake} (consecutive: ${maxConsecutiveDeepfake}, percentage: ${(deepfakePercentage * 100).toFixed(1)}%)`);
  if (details.ai_generated.detectedSource) {
    console.log(`[HiveAI] Detected source: ${details.ai_generated.detectedSource} (confidence: ${details.ai_generated.sourceConfidence.toFixed(3)})`);
  }

  return { scores, details, flaggedFrames };
}

/**
 * Normalize combined Hive.AI response (moderation + AI detection)
 * @param {Object} hiveResult - Combined result from moderateVideoWithHiveAI
 * @returns {Object} Normalized moderation result
 */
export function normalizeHiveAIResponse(hiveResult) {
  // Initialize with all categories at 0
  const scores = {
    nudity: 0,
    violence: 0,
    gore: 0,
    offensive: 0,
    weapons: 0,
    drugs: 0,
    alcohol: 0,
    tobacco: 0,
    gambling: 0,
    selfHarm: 0,
    ai_generated: 0,
    deepfake: 0
  };

  const details = {
    ai_generated: {
      maxScore: 0,
      detectedSource: null,
      sourceConfidence: 0,
      framesDetected: 0,
      totalFrames: 0
    },
    deepfake: {
      maxScore: 0,
      consecutiveFrames: 0,
      framesDetected: 0,
      totalFrames: 0
    }
  };

  let flaggedFrames = [];

  // Process moderation results
  if (hiveResult.moderation) {
    const modNorm = normalizeModerationResponse(hiveResult.moderation);
    Object.assign(scores, modNorm.scores);
    Object.assign(details, modNorm.details);
    flaggedFrames = flaggedFrames.concat(modNorm.flaggedFrames);
  }

  // Process AI detection results
  if (hiveResult.aiDetection) {
    const aiNorm = normalizeAIDetectionResponse(hiveResult.aiDetection);
    scores.ai_generated = aiNorm.scores.ai_generated;
    scores.deepfake = aiNorm.scores.deepfake;
    details.ai_generated = aiNorm.details.ai_generated;
    details.deepfake = aiNorm.details.deepfake;
    flaggedFrames = flaggedFrames.concat(aiNorm.flaggedFrames);
  }

  // Sort flagged frames by position
  flaggedFrames.sort((a, b) => a.position - b.position);

  return { scores, details, flaggedFrames };
}
