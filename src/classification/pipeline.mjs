// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Classification pipeline for video topic/category detection
// ABOUTME: Coordinates VLM classification provider to produce recommendation labels

import { HiveVLMClassificationProvider } from './providers/hiveai/adapter.mjs';

// Singleton provider instance
const vlmProvider = new HiveVLMClassificationProvider();

/**
 * Run the VLM classification pipeline on a video.
 *
 * Calls the Hive AI VLM (Vision Language Model) API and returns
 * structured topics, setting, objects, activities, mood, and a
 * human-readable description -- plus pre-formatted recommendation
 * labels for downstream systems (funnelcake, gorse).
 *
 * @param {string} videoUrl - Public URL to the video
 * @param {Object} env - Environment variables (needs HIVE_VLM_API_KEY)
 * @param {Object} options - Pipeline options
 * @param {string} [options.sha256] - Video hash (for logging / correlation)
 * @param {Function} [options.fetchFn] - Custom fetch (for testing)
 * @param {number} [options.maxLabels=50] - Maximum labels to return
 * @returns {Promise<Object>} Classification result
 */
export async function classifyVideo(videoUrl, env, options = {}) {
  const sha256 = options.sha256 || 'unknown';

  // Validate configuration
  if (!vlmProvider.isConfigured(env)) {
    console.warn('[Classification] HIVE_VLM_API_KEY not configured - skipping classification');
    return {
      provider: null,
      skipped: true,
      reason: 'HIVE_VLM_API_KEY not configured',
      labels: [],
      topics: [],
      setting: '',
      objects: [],
      activities: [],
      mood: '',
      description: '',
      topCategories: [],
      topSettings: [],
      topObjects: []
    };
  }

  console.log(`[Classification] Starting VLM classification pipeline for ${sha256}`);

  try {
    const result = await vlmProvider.classify(
      videoUrl,
      { sha256 },
      env,
      {
        fetchFn: options.fetchFn,
        maxLabels: options.maxLabels
      }
    );

    console.log(
      `[Classification] Pipeline complete for ${sha256}: ` +
      `${result.labels.length} labels, ${result.topics.length} topics`
    );

    return {
      ...result,
      sha256,
      skipped: false
    };

  } catch (error) {
    console.error(`[Classification] Pipeline failed for ${sha256}:`, error.message);
    throw error;
  }
}

/**
 * Format classification result for storage in KV.
 *
 * Strips the raw provider response to keep the stored payload compact.
 * Includes the VLM description (valuable for search and human review).
 *
 * @param {Object} classificationResult - Output of classifyVideo
 * @returns {Object|null} Compact representation for KV storage
 */
export function formatForStorage(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return null;
  }

  return {
    provider: classificationResult.provider,
    sha256: classificationResult.sha256,
    processingTime: classificationResult.processingTime,
    labels: classificationResult.labels,
    topics: classificationResult.topics,
    setting: classificationResult.setting,
    objects: classificationResult.objects,
    activities: classificationResult.activities,
    mood: classificationResult.mood,
    description: classificationResult.description,
    topCategories: classificationResult.topCategories,
    topSettings: classificationResult.topSettings,
    topObjects: classificationResult.topObjects,
    classesDetected: classificationResult.classesDetected,
    extractedAt: classificationResult.extractedAt
  };
}

/**
 * Format classification labels into the gorse item-labels payload.
 *
 * Gorse expects item labels as an array of strings.  We prefix each
 * label with its namespace so topics from different axes don't collide:
 *
 *   topic:music, setting:indoor-studio, object:microphone
 *
 * @param {Object} classificationResult - Output of classifyVideo
 * @returns {string[]} Array of namespaced label strings for gorse
 */
export function formatForGorse(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return [];
  }

  return (classificationResult.labels || []).map(
    ({ label, namespace }) => `${namespace}:${label}`
  );
}

/**
 * Format classification result into the funnelcake topics payload.
 *
 * Funnelcake expects a map of topic -> weight (0-1).
 *
 * @param {Object} classificationResult - Output of classifyVideo
 * @returns {Object} Map of topic string to weight
 */
export function formatForFunnelcake(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return {};
  }

  const topics = {};
  for (const { label, namespace, score } of (classificationResult.labels || [])) {
    topics[`${namespace}:${label}`] = score;
  }
  return topics;
}
