// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Hive.AI provider adapter for pluggable moderation architecture
// ABOUTME: Unified provider for content moderation AND AI-generated content detection

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithHiveAI } from './client.mjs';
import { normalizeHiveAIResponse } from './normalizer.mjs';

export class HiveAIProvider extends BaseModerationProvider {
  constructor() {
    super('hiveai', {
      ...STANDARD_CAPABILITIES,
      // Content moderation (via HIVE_MODERATION_API_KEY)
      nudity: true,
      violence: true,
      gore: true,
      offensive: true,
      weapons: true,
      drugs: true,
      alcohol: true,
      tobacco: true,
      gambling: true,
      selfHarm: true,

      // AI detection (via HIVE_AI_DETECTION_API_KEY)
      ai_generated: true,
      deepfake: true,

      // Technical capabilities
      textOcr: false,
      qrCode: false,
      asyncProcessing: true,
      liveStream: false,
      customModels: true,

      // Supported input
      maxFileSizeMB: null,
      maxDurationMinutes: null,
      supportedFormats: ['mp4', 'webm', 'avi', 'mkv', 'wmv', 'mov']
    });
  }

  /**
   * Check if Hive.AI is configured (at least one API key present)
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    return !!(env.HIVE_MODERATION_API_KEY || env.HIVE_AI_DETECTION_API_KEY);
  }

  /**
   * Get which capabilities are actually available based on configured keys
   * @param {Object} env - Environment variables
   * @returns {Object} Available capabilities
   */
  getAvailableCapabilities(env) {
    const caps = { ...this.capabilities };

    // If no moderation key, disable content moderation capabilities
    if (!env.HIVE_MODERATION_API_KEY) {
      caps.nudity = false;
      caps.violence = false;
      caps.gore = false;
      caps.offensive = false;
      caps.weapons = false;
      caps.drugs = false;
      caps.alcohol = false;
      caps.tobacco = false;
      caps.gambling = false;
      caps.selfHarm = false;
    }

    // If no AI detection key, disable AI detection capabilities
    if (!env.HIVE_AI_DETECTION_API_KEY) {
      caps.ai_generated = false;
      caps.deepfake = false;
    }

    return caps;
  }

  /**
   * Moderate video with Hive.AI (moderation + AI detection)
   * @param {string} videoUrl - Public URL to video
   * @param {Object} metadata - Video metadata (sha256, etc)
   * @param {Object} env - Environment with Hive.AI credentials
   * @param {Object} options - Moderation options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      const hasModeration = !!env.HIVE_MODERATION_API_KEY;
      // Skip AI detection for original Vines (pre-2018 content predates AI generation)
      const hasAIDetection = !!env.HIVE_AI_DETECTION_API_KEY && !options.skipAIDetection;

      console.log(`[HiveAI] Starting moderation for ${metadata.sha256}`);
      console.log(`[HiveAI] Models: content=${hasModeration}, ai_detection=${hasAIDetection}${options.skipAIDetection ? ' (skipped - original Vine)' : ''}`);

      // Call Hive.AI APIs (runs both in parallel if both keys present)
      const rawResult = await moderateVideoWithHiveAI(
        videoUrl,
        metadata,
        env,
        options
      );

      // Normalize response to standard format
      const normalized = normalizeHiveAIResponse(rawResult);

      const processingTime = Date.now() - startTime;
      console.log(`[HiveAI] Completed in ${processingTime}ms`);

      return {
        ...normalized,
        provider: this.name,
        processingTime,
        raw: rawResult
      };

    } catch (error) {
      console.error(`[HiveAI] Moderation failed:`, error.message);
      throw new Error(`Hive.AI moderation failed: ${error.message}`);
    }
  }
}
