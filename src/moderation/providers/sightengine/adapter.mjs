// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Sightengine provider adapter for pluggable moderation architecture
// ABOUTME: Wraps existing Sightengine client in BaseModerationProvider interface

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithSightengine } from '../../sightengine.mjs';

export class SightengineProvider extends BaseModerationProvider {
  constructor() {
    super('sightengine', {
      ...STANDARD_CAPABILITIES,
      aiGenerated: true,
      deepfake: true,
      textOcr: true,
      qrCode: true,
      liveStream: true,
      asyncProcessing: false // Synchronous API
    });
  }

  /**
   * Check if Sightengine is configured
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    return !!(env.SIGHTENGINE_API_USER && env.SIGHTENGINE_API_SECRET);
  }

  /**
   * Moderate video with Sightengine
   * @param {string} videoUrl - Public URL to video
   * @param {Object} metadata - Video metadata (sha256, etc)
   * @param {Object} env - Environment with Sightengine credentials
   * @param {Object} options - Moderation options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[Sightengine] Starting moderation for ${metadata.sha256}`);

      // Call existing Sightengine implementation
      const rawResult = await moderateVideoWithSightengine(
        videoUrl,
        metadata,
        env,
        options.fetchFn
      );

      // Sightengine already returns a normalized-ish format
      // Extract the parts we need - use maxScores object directly
      const normalized = {
        scores: {
          nudity: rawResult.maxScores?.nudity || 0,
          sexual: rawResult.maxScores?.sexual || 0,
          porn: rawResult.maxScores?.porn || 0,
          violence: rawResult.maxScores?.violence || 0,
          gore: rawResult.maxScores?.gore || 0,
          offensive: rawResult.maxScores?.offensive || 0,
          weapon: rawResult.maxScores?.weapon || 0,
          recreational_drug: rawResult.maxScores?.recreational_drug || 0,
          alcohol: rawResult.maxScores?.alcohol || 0,
          tobacco: rawResult.maxScores?.tobacco || 0,
          gambling: rawResult.maxScores?.gambling || 0,
          self_harm: rawResult.maxScores?.self_harm || 0,
          ai_generated: rawResult.maxScores?.ai_generated || 0,
          deepfake: rawResult.maxScores?.deepfake || 0,
          medical: rawResult.maxScores?.medical || 0,
          money: rawResult.maxScores?.money || 0,
          destruction: rawResult.maxScores?.destruction || 0,
          military: rawResult.maxScores?.military || 0,
          text_profanity: rawResult.maxScores?.text_profanity || 0,
          qr_unsafe: rawResult.maxScores?.qr_unsafe || 0
        },
        details: rawResult.detailedCategories || {},
        flaggedFrames: rawResult.flaggedFrames || []
      };

      const processingTime = Date.now() - startTime;
      console.log(`[Sightengine] Completed in ${processingTime}ms`);

      return {
        ...normalized,
        provider: this.name,
        processingTime,
        raw: rawResult
      };

    } catch (error) {
      console.error(`[Sightengine] Moderation failed:`, error);
      throw new Error(`Sightengine moderation failed: ${error.message}`);
    }
  }
}
