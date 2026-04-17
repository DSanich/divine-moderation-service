// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Sightengine API client for video content moderation
// ABOUTME: Handles video analysis and score extraction from Sightengine service

const SIGHTENGINE_API_URL = 'https://api.sightengine.com/1.0/video/check-sync.json';

// Threshold for flagging individual frames
const NUDITY_THRESHOLD = 0.7;
const VIOLENCE_THRESHOLD = 0.7;
const AI_GENERATED_THRESHOLD = 0.7;

/**
 * Moderate a video using Sightengine API
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} metadata - Video metadata (sha256, etc)
 * @param {Object} env - Environment variables with API credentials
 * @param {Function} [fetchFn=fetch] - Fetch function (for testing)
 * @returns {Promise<Object>} Moderation result with scores and flagged frames
 */
export async function moderateVideoWithSightengine(videoUrl, metadata, env, fetchFn = fetch) {
  // Validate credentials
  if (!env.SIGHTENGINE_API_USER || !env.SIGHTENGINE_API_SECRET) {
    throw new Error('Sightengine API credentials not configured');
  }

  try {
    // Build URL with query parameters (GET request for video URL moderation)
    const url = new URL(SIGHTENGINE_API_URL);
    url.searchParams.append('stream_url', videoUrl);
    // Request comprehensive moderation models including deepfake and near-duplicate detection
    url.searchParams.append('models', 'nudity-2.1,violence,offensive-2.0,gore-2.0,genai,deepfake,weapon,recreational_drug,alcohol,tobacco,medical,gambling,money,self-harm,destruction,military,text-content,qr-content');
    url.searchParams.append('api_user', env.SIGHTENGINE_API_USER);
    url.searchParams.append('api_secret', env.SIGHTENGINE_API_SECRET);

    const response = await fetchFn(url.toString(), {
      method: 'GET'
    });

    if (!response.ok) {
      throw new Error(`Sightengine API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.status !== 'success') {
      throw new Error(`Sightengine returned error: ${data.error?.message || 'Unknown error'}`);
    }

    // Extract scores from frames
    const frames = data.data?.frames || [];
    const result = analyzeFrames(frames);

    return {
      status: 'success',
      frames,
      ...result
    };

  } catch (error) {
    // Re-throw with context
    throw error;
  }
}

/**
 * Analyze frames and extract max scores from all models with detailed subcategories
 * @param {Array} frames - Frame analysis results from Sightengine
 * @returns {Object} Aggregated scores, detailed categories, and flagged frames
 */
function analyzeFrames(frames) {
  // Initialize max scores for all categories
  const maxScores = {
    nudity: 0,
    sexual: 0,
    porn: 0,
    violence: 0,
    ai_generated: 0,
    deepfake: 0,
    gore: 0,
    offensive: 0,
    weapon: 0,
    recreational_drug: 0,
    alcohol: 0,
    tobacco: 0,
    medical: 0,
    gambling: 0,
    money: 0,
    self_harm: 0,
    destruction: 0,
    military: 0,
    text_profanity: 0,
    qr_unsafe: 0
  };

  // Track detailed subcategories for ALL models
  const detailedCategories = {
    nudity: {},
    violence: {},
    gore: {},
    offensive: {},
    weapon: {},
    self_harm: {},
    recreational_drug: {},
    tobacco: {},
    medical: {},
    destruction: {},
    military: {},
    text_content: {},
    qr_content: {},
    alcohol: {},
    gambling: {},
    money: {},
    deepfake: {},
    ai_generated: {}
  };

  const flaggedFrames = [];

  for (const frame of frames) {
    const position = frame.info?.position || 0;
    const frameScores = {};
    const frameDetails = {};

    // NUDITY-2.1: Detailed adult content classification
    // Support both old format (raw/partial) and new format (detailed categories)
    const broadNudity = Math.max(
      frame.nudity?.raw || 0,  // Legacy support
      frame.nudity?.partial || 0,  // Legacy support
      frame.nudity?.suggestive || 0,
      frame.nudity?.mildly_suggestive || 0
    );
    const nuditySuggestive = Math.max(
      frame.nudity?.visibly_undressed || 0,
      frame.nudity?.lingerie || 0,
      frame.nudity?.male_underwear || 0
    );
    frameScores.nudity = Math.max(broadNudity, nuditySuggestive);
    frameScores.sexual = Math.max(
      frame.nudity?.sexual_display || 0,
      frame.nudity?.erotica || 0,
      frame.nudity?.very_suggestive || 0,
      frame.nudity?.sextoy || 0,
      frame.nudity?.suggestive_focus || 0,
      frame.nudity?.suggestive_pose || 0
    );
    frameScores.porn = frame.nudity?.sexual_activity || 0;
    frameDetails.nudity = {
      sexual_activity: frame.nudity?.sexual_activity || 0,
      sexual_display: frame.nudity?.sexual_display || 0,
      erotica: frame.nudity?.erotica || 0,
      very_suggestive: frame.nudity?.very_suggestive || 0,
      suggestive: frame.nudity?.suggestive || 0,
      visibly_undressed: frame.nudity?.visibly_undressed || 0,
      sextoy: frame.nudity?.sextoy || 0,
      suggestive_focus: frame.nudity?.suggestive_focus || 0,
      suggestive_pose: frame.nudity?.suggestive_pose || 0,
      lingerie: frame.nudity?.lingerie || 0,
      male_underwear: frame.nudity?.male_underwear || 0
    };

    // VIOLENCE: Physical violence and threats
    frameScores.violence = Math.max(
      frame.violence?.physical_violence || 0,
      frame.violence?.firearm_threat || 0,
      frame.violence?.combat_sport || 0,
      frame.violence?.prob || 0
    );
    frameDetails.violence = {
      physical_violence: frame.violence?.physical_violence || 0,
      firearm_threat: frame.violence?.firearm_threat || 0,
      combat_sport: frame.violence?.combat_sport || 0
    };

    // GORE-2.0: Blood, injuries, corpses
    frameScores.gore = Math.max(
      frame.gore?.very_bloody || 0,
      frame.gore?.slightly_bloody || 0,
      frame.gore?.body_organ || 0,
      frame.gore?.serious_injury || 0,
      frame.gore?.superficial_injury || 0,
      frame.gore?.corpse || 0,
      frame.gore?.skull || 0,
      frame.gore?.unconscious || 0,
      frame.gore?.body_waste || 0,
      frame.gore?.prob || 0
    );
    frameDetails.gore = {
      very_bloody: frame.gore?.very_bloody || 0,
      slightly_bloody: frame.gore?.slightly_bloody || 0,
      body_organ: frame.gore?.body_organ || 0,
      serious_injury: frame.gore?.serious_injury || 0,
      corpse: frame.gore?.corpse || 0,
      skull: frame.gore?.skull || 0,
      real: frame.gore?.real || 0,
      fake: frame.gore?.fake || 0,
      animated: frame.gore?.animated || 0
    };

    // OFFENSIVE-2.0: Hate symbols and gestures
    frameScores.offensive = Math.max(
      frame.offensive?.nazi || 0,
      frame.offensive?.supremacist || 0,
      frame.offensive?.confederate || 0,
      frame.offensive?.terrorist || 0,
      frame.offensive?.middle_finger || 0,
      frame.offensive?.prob || 0
    );
    frameDetails.offensive = {
      nazi: frame.offensive?.nazi || 0,
      asian_swastika: frame.offensive?.asian_swastika || 0,
      supremacist: frame.offensive?.supremacist || 0,
      confederate: frame.offensive?.confederate || 0,
      terrorist: frame.offensive?.terrorist || 0,
      middle_finger: frame.offensive?.middle_finger || 0
    };

    // WEAPON: Firearms, knives, threats
    frameScores.weapon = Math.max(
      frame.weapon?.firearm || 0,
      frame.weapon?.knife || 0,
      frame.weapon?.firearm_gesture || 0,
      frame.weapon?.prob || 0
    );
    frameDetails.weapon = {
      firearm: frame.weapon?.firearm || 0,
      knife: frame.weapon?.knife || 0,
      firearm_gesture: frame.weapon?.firearm_gesture || 0,
      firearm_toy: frame.weapon?.firearm_toy || 0,
      aiming_threat: frame.weapon?.aiming_threat || 0,
      aiming_camera: frame.weapon?.aiming_camera || 0
    };

    // SELF-HARM: Critical category
    frameScores.self_harm = Math.max(
      frame['self-harm']?.real || 0,
      frame['self-harm']?.fake || 0,
      frame['self-harm']?.animated || 0,
      frame['self-harm']?.prob || 0
    );
    frameDetails.self_harm = {
      real: frame['self-harm']?.real || 0,
      fake: frame['self-harm']?.fake || 0,
      animated: frame['self-harm']?.animated || 0
    };

    // AI-generated and deepfake detection
    frameScores.ai_generated = frame.type?.ai_generated || 0;
    frameDetails.ai_generated = {
      ai_generated: frame.type?.ai_generated || 0
    };

    frameScores.deepfake = frame.deepfake?.prob || 0;
    frameDetails.deepfake = {
      prob: frame.deepfake?.prob || 0
    };

    // Recreational drug score
    frameScores.recreational_drug = Math.max(
      frame.recreational_drug?.prob || 0,
      frame.recreational_drug?.cannabis || 0,
      frame.recreational_drug?.cannabis_drug || 0,
      frame.recreational_drug?.recreational_drug_not_cannabis || 0
    );
    frameDetails.recreational_drug = {
      cannabis: frame.recreational_drug?.cannabis || 0,
      cannabis_drug: frame.recreational_drug?.cannabis_drug || 0,
      recreational_drug_not_cannabis: frame.recreational_drug?.recreational_drug_not_cannabis || 0
    };

    // Alcohol score
    frameScores.alcohol = frame.alcohol?.prob || 0;
    frameDetails.alcohol = {
      prob: frame.alcohol?.prob || 0
    };

    // Tobacco score
    frameScores.tobacco = Math.max(
      frame.tobacco?.regular_tobacco || 0,
      frame.tobacco?.ambiguous_tobacco || 0,
      frame.tobacco?.prob || 0
    );
    frameDetails.tobacco = {
      regular_tobacco: frame.tobacco?.regular_tobacco || 0,
      ambiguous_tobacco: frame.tobacco?.ambiguous_tobacco || 0
    };

    // Medical score
    frameScores.medical = Math.max(
      frame.medical?.prob || 0,
      frame.medical?.medical_drug || 0,
      frame.medical?.medical_paraphernalia || 0
    );
    frameDetails.medical = {
      medical_drug: frame.medical?.medical_drug || 0,
      medical_paraphernalia: frame.medical?.medical_paraphernalia || 0
    };

    // Gambling score
    frameScores.gambling = frame.gambling?.prob || 0;
    frameDetails.gambling = {
      prob: frame.gambling?.prob || 0
    };

    // Money score
    frameScores.money = frame.money?.prob || 0;
    frameDetails.money = {
      prob: frame.money?.prob || 0
    };

    // Destruction score
    frameScores.destruction = Math.max(
      frame.destruction?.prob || 0,
      frame.destruction?.building_major_damage || 0,
      frame.destruction?.building_on_fire || 0,
      frame.destruction?.wildfire || 0,
      frame.destruction?.violent_protest || 0
    );
    frameDetails.destruction = {
      building_major_damage: frame.destruction?.building_major_damage || 0,
      building_on_fire: frame.destruction?.building_on_fire || 0,
      wildfire: frame.destruction?.wildfire || 0,
      violent_protest: frame.destruction?.violent_protest || 0
    };

    // Military score
    frameScores.military = Math.max(
      frame.military?.prob || 0,
      frame.military?.military_equipment || 0,
      frame.military?.military_personnel || 0
    );
    frameDetails.military = {
      military_equipment: frame.military?.military_equipment || 0,
      military_personnel: frame.military?.military_personnel || 0
    };

    // Text content moderation (OCR)
    frameScores.text_profanity = Math.max(
      frame['text-content']?.profanity?.sexual || 0,
      frame['text-content']?.profanity?.discriminatory || 0,
      frame['text-content']?.profanity?.insult || 0,
      frame['text-content']?.profanity?.inappropriate || 0
    );
    frameDetails.text_content = {
      profanity_sexual: frame['text-content']?.profanity?.sexual || 0,
      profanity_discriminatory: frame['text-content']?.profanity?.discriminatory || 0,
      profanity_insult: frame['text-content']?.profanity?.insult || 0,
      profanity_inappropriate: frame['text-content']?.profanity?.inappropriate || 0
    };

    // QR code moderation
    frameScores.qr_unsafe = Math.max(
      frame['qr-content']?.link || 0,
      frame['qr-content']?.profanity || 0,
      frame['qr-content']?.personal || 0
    );
    frameDetails.qr_content = {
      link: frame['qr-content']?.link || 0,
      profanity: frame['qr-content']?.profanity || 0,
      personal: frame['qr-content']?.personal || 0
    };

    // Track maximums across all frames
    for (const [key, value] of Object.entries(frameScores)) {
      maxScores[key] = Math.max(maxScores[key], value);
    }

    // Track maximum detailed subcategories
    for (const [category, details] of Object.entries(frameDetails)) {
      if (!detailedCategories[category]) continue;
      for (const [subcat, score] of Object.entries(details)) {
        detailedCategories[category][subcat] = Math.max(
          detailedCategories[category][subcat] || 0,
          score
        );
      }
    }

    // Flag frames exceeding thresholds (using 0.7 as universal threshold)
    const hasHighScore = Object.values(frameScores).some(score => score >= 0.7);
    if (hasHighScore) {
      // Find primary concern for this frame
      const primaryConcern = Object.entries(frameScores).reduce((a, b) =>
        frameScores[a[0]] >= frameScores[b[0]] ? a : b
      );

      flaggedFrames.push({
        position,
        ...frameScores,
        details: frameDetails,
        primaryConcern: primaryConcern[0],
        primaryScore: primaryConcern[1]
      });
    }
  }

  return {
    // Legacy format for backward compatibility
    maxNudityScore: maxScores.nudity,
    maxViolenceScore: maxScores.violence,
    maxAiGeneratedScore: maxScores.ai_generated,

    // New comprehensive scores
    maxScores,

    // Detailed subcategories for fine-grained filtering
    detailedCategories,

    flaggedFrames
  };
}
