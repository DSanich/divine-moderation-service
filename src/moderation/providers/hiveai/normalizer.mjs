// ABOUTME: Normalizes Hive.AI AI-generated detection responses to standard format
// ABOUTME: Maps Hive.AI frame-level classifications to Divine's schema

/**
 * Normalize Hive.AI AI-generated detection response to standard format
 *
 * Hive.AI provides two classification heads:
 * 1. Generation: ai_generated vs not_ai_generated
 * 2. Source: dall_e, midjourney, stable_diffusion, flux, etc. or none
 *
 * @param {Object} hiveResult - Raw Hive.AI API response
 * @returns {Object} Normalized moderation result
 */
export function normalizeHiveAIResponse(hiveResult) {
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
    ai_generated: 0,  // Use snake_case to match classifier
    deepfake: 0
  };

  const details = {
    ai_generated: {  // Use snake_case to match classifier
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

  // Parse Hive.AI response structure
  const status = hiveResult.status?.[0];
  if (!status || !status.response) {
    console.warn('[HiveAI] No response data in API result');
    return { scores, details, flaggedFrames };
  }

  const output = status.response.output || [];
  details.ai_generated.totalFrames = output.length;
  details.deepfake.totalFrames = output.length;

  let consecutiveDeepfakeCount = 0;
  let maxConsecutiveDeepfake = 0;

  // Process each frame
  for (let i = 0; i < output.length; i++) {
    const frame = output[i];
    const classes = frame.classes || [];

    let frameAIScore = 0;
    let frameDeepfakeScore = 0;
    let detectedSource = null;
    let sourceScore = 0;

    // Parse classifications
    for (const cls of classes) {
      const className = cls.class.toLowerCase();
      const score = parseFloat(cls.score) || 0;

      if (className === 'ai_generated') {
        frameAIScore = score;
      } else if (className === 'not_ai_generated') {
        // Inverse score for not_ai_generated
        frameAIScore = Math.max(frameAIScore, 1 - score);
      } else if (className === 'deepfake') {
        frameDeepfakeScore = score;
      } else if (className !== 'none' && className !== 'inconclusive') {
        // This is a source classification (dall_e, midjourney, etc.)
        if (score > sourceScore) {
          detectedSource = className;
          sourceScore = score;
        }
      }
    }

    // Track max scores
    scores.ai_generated = Math.max(scores.ai_generated, frameAIScore);
    scores.deepfake = Math.max(scores.deepfake, frameDeepfakeScore);

    // Track detected source
    if (detectedSource && sourceScore > details.ai_generated.sourceConfidence) {
      details.ai_generated.detectedSource = detectedSource;
      details.ai_generated.sourceConfidence = sourceScore;
    }

    // Count frames with AI-generated detection (Hive.AI recommends 0.9 threshold)
    if (frameAIScore >= 0.9) {
      details.ai_generated.framesDetected++;
      details.ai_generated.maxScore = Math.max(details.ai_generated.maxScore, frameAIScore);
    }

    // Track consecutive deepfake frames (Hive.AI recommends 0.5 on two consecutive)
    if (frameDeepfakeScore >= 0.5) {
      consecutiveDeepfakeCount++;
      maxConsecutiveDeepfake = Math.max(maxConsecutiveDeepfake, consecutiveDeepfakeCount);
      details.deepfake.framesDetected++;
      details.deepfake.maxScore = Math.max(details.deepfake.maxScore, frameDeepfakeScore);
    } else {
      consecutiveDeepfakeCount = 0;
    }

    // Flag frames that exceed thresholds
    if (frameAIScore >= 0.9 || frameDeepfakeScore >= 0.5) {
      flaggedFrames.push({
        position: frame.time || i,
        primaryConcern: frameAIScore >= 0.9 ? 'ai_generated' : 'deepfake',
        primaryScore: Math.max(frameAIScore, frameDeepfakeScore),
        scores: {
          ai_generated: frameAIScore,
          deepfake: frameDeepfakeScore
        },
        detectedSource: detectedSource,
        sourceConfidence: sourceScore
      });
    }
  }

  details.deepfake.consecutiveFrames = maxConsecutiveDeepfake;

  // Calculate percentage of frames flagged (Hive.AI recommends 5% threshold for deepfake)
  const deepfakePercentage = details.deepfake.totalFrames > 0
    ? (details.deepfake.framesDetected / details.deepfake.totalFrames)
    : 0;

  // Apply Hive.AI recommended thresholds
  // - AI-generated: 0.9 on any frame
  // - Deepfake: 0.5 on two consecutive frames, OR 5% of all frames
  const isAIGenerated = scores.ai_generated >= 0.9;
  const isDeepfake = (maxConsecutiveDeepfake >= 2 && scores.deepfake >= 0.5) || deepfakePercentage >= 0.05;

  console.log(`[HiveAI] AI-Generated: ${isAIGenerated} (max: ${scores.ai_generated.toFixed(3)})`);
  console.log(`[HiveAI] Deepfake: ${isDeepfake} (consecutive: ${maxConsecutiveDeepfake}, percentage: ${(deepfakePercentage * 100).toFixed(1)}%)`);
  if (details.ai_generated.detectedSource) {
    console.log(`[HiveAI] Detected source: ${details.ai_generated.detectedSource} (confidence: ${details.ai_generated.sourceConfidence.toFixed(3)})`);
  }

  return {
    scores,
    details,
    flaggedFrames
  };
}
