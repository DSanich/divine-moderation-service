// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Hive VLM (Vision Language Model) classification provider adapter
// ABOUTME: Wraps the Hive VLM client + normalizer behind a clean interface

import { classifyWithHiveVLM } from './client.mjs';
import { normalizeVLMResponse, toRecommendationLabels } from './normalizer.mjs';

/**
 * Hive AI VLM Classification provider.
 *
 * This provider calls the Hive V3 chat/completions API with a
 * vision-language model to classify video content. The VLM analyses
 * sampled frames and returns structured JSON with topics, setting,
 * objects, activities, mood, and a description.
 *
 * The output is designed to feed downstream recommendation engines
 * (funnelcake, gorse) with topic labels.
 */
export class HiveVLMClassificationProvider {
  constructor() {
    this.name = 'hiveai-vlm';
  }

  /**
   * Check if the VLM classification provider is configured.
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    return !!env.HIVE_VLM_API_KEY;
  }

  /**
   * Classify a video with Hive AI VLM.
   *
   * @param {string} videoUrl - Public URL to the video
   * @param {Object} metadata - Video metadata (sha256, etc.)
   * @param {Object} env - Environment with HIVE_VLM_API_KEY
   * @param {Object} options - Options (fetchFn for testing, maxLabels)
   * @returns {Promise<Object>} Classification result with labels
   */
  async classify(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[HiveAI:VLM] Starting classification for ${metadata.sha256 || 'unknown'}`);

      // Call Hive VLM API
      const rawResponse = await classifyWithHiveVLM(videoUrl, env, options);

      // Normalise response
      const normalized = normalizeVLMResponse(rawResponse);

      // Generate recommendation labels
      const labels = toRecommendationLabels(normalized, {
        maxLabels: options.maxLabels
      });

      const processingTime = Date.now() - startTime;
      console.log(
        `[HiveAI:VLM] Completed in ${processingTime}ms ` +
        `(${labels.length} labels, ${normalized.topics.length} topics)`
      );

      return {
        provider: this.name,
        processingTime,

        // Structured classification data
        topics: normalized.topics,
        setting: normalized.setting,
        objects: normalized.objects,
        activities: normalized.activities,
        mood: normalized.mood,
        description: normalized.description,

        // Pre-built recommendation labels (ready for funnelcake / gorse)
        labels,

        // Convenience top-N lists (same shape as old provider for compatibility)
        topCategories: normalized.topCategories,
        topSettings: normalized.topSettings,
        topObjects: normalized.topObjects,

        // Token usage (for cost tracking)
        usage: normalized.usage,

        // Metadata
        classesDetected: normalized.classesDetected,
        extractedAt: normalized.extractedAt,

        // Raw response (for debugging / auditing)
        raw: rawResponse
      };

    } catch (error) {
      console.error(`[HiveAI:VLM] Classification failed:`, error.message);
      throw new Error(`Hive VLM classification failed: ${error.message}`);
    }
  }
}
