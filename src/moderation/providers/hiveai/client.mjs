// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Hive.AI API client for content moderation and AI-generated detection
// ABOUTME: Uses Hive.AI V2 API with separate keys for moderation and AI detection models

const HIVE_API_ENDPOINT = 'https://api.thehive.ai/api/v2/task/sync';

/**
 * Call Hive.AI V2 API with a specific API key
 * @param {string} videoUrl - Public URL to video/image
 * @param {string} apiKey - Hive API key (determines which model runs)
 * @param {Object} options - Options (fetchFn for testing)
 * @returns {Promise<Object>} Raw Hive.AI API response
 */
async function callHiveAPI(videoUrl, apiKey, options = {}) {
  const fetchFn = options.fetchFn || fetch;

  const formData = new FormData();
  formData.append('url', videoUrl);

  const response = await fetchFn(HIVE_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'authorization': `token ${apiKey}`,
      'accept': 'application/json'
    },
    body: formData
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Hive.AI API error: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Moderate video using Hive.AI content moderation model
 * Detects: nudity, violence, gore, weapons, drugs, alcohol, tobacco, gambling, etc.
 *
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} env - Environment with HIVE_MODERATION_API_KEY
 * @param {Object} options - Options (fetchFn for testing)
 * @returns {Promise<Object>} Raw Hive.AI moderation response
 */
export async function moderateWithHiveModeration(videoUrl, env, options = {}) {
  if (!env.HIVE_MODERATION_API_KEY) {
    throw new Error('HIVE_MODERATION_API_KEY not configured');
  }

  console.log('[HiveAI] Submitting for content moderation:', videoUrl);
  const result = await callHiveAPI(videoUrl, env.HIVE_MODERATION_API_KEY, options);
  console.log('[HiveAI] Received moderation response');
  return result;
}

/**
 * Detect AI-generated content using Hive.AI AI detection model
 * Detects: AI-generated content, deepfakes, source identification (Midjourney, DALL-E, etc.)
 *
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} env - Environment with HIVE_AI_DETECTION_API_KEY
 * @param {Object} options - Options (fetchFn for testing)
 * @returns {Promise<Object>} Raw Hive.AI AI detection response
 */
export async function moderateWithHiveAIDetection(videoUrl, env, options = {}) {
  if (!env.HIVE_AI_DETECTION_API_KEY) {
    throw new Error('HIVE_AI_DETECTION_API_KEY not configured');
  }

  console.log('[HiveAI] Submitting for AI-generated detection:', videoUrl);
  const result = await callHiveAPI(videoUrl, env.HIVE_AI_DETECTION_API_KEY, options);
  console.log('[HiveAI] Received AI detection response');
  return result;
}

/**
 * Run both Hive.AI models in parallel (moderation + AI detection)
 *
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} env - Environment with both API keys
 * @param {Object} options - Options (fetchFn for testing)
 * @returns {Promise<Object>} Combined results from both models
 */
export async function moderateVideoWithHiveAI(videoUrl, metadata, env, options = {}) {
  const results = {
    moderation: null,
    aiDetection: null,
    errors: [],
    skippedAIDetection: false
  };

  // Run both APIs in parallel unless the policy layer skips AI detection.
  const promises = [];

  if (env.HIVE_MODERATION_API_KEY) {
    promises.push(
      moderateWithHiveModeration(videoUrl, env, options)
        .then(r => { results.moderation = r; })
        .catch(e => { results.errors.push({ model: 'moderation', error: e.message }); })
    );
  }

  if (env.HIVE_AI_DETECTION_API_KEY && !options.skipAIDetection) {
    promises.push(
      moderateWithHiveAIDetection(videoUrl, env, options)
        .then(r => { results.aiDetection = r; })
        .catch(e => { results.errors.push({ model: 'aiDetection', error: e.message }); })
    );
  } else if (options.skipAIDetection) {
    results.skippedAIDetection = true;
    console.log('[HiveAI] Skipping AI detection (policy gate)');
  }

  if (promises.length === 0) {
    throw new Error('No Hive.AI API keys configured. Set HIVE_MODERATION_API_KEY and/or HIVE_AI_DETECTION_API_KEY');
  }

  await Promise.all(promises);

  // If all active calls failed, throw (but not if we intentionally skipped AI detection)
  if (!results.moderation && !results.aiDetection && !results.skippedAIDetection) {
    throw new Error(`All Hive.AI models failed: ${results.errors.map(e => `${e.model}: ${e.error}`).join('; ')}`);
  }

  console.log(`[HiveAI] Completed - moderation: ${results.moderation ? 'OK' : 'N/A'}, AI detection: ${results.aiDetection ? 'OK' : (results.skippedAIDetection ? 'SKIPPED' : 'N/A')}`);

  return results;
}
