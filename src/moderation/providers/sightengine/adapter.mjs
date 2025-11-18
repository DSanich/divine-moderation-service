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
      // Extract the parts we need
      const normalized = {
        scores: {
          nudity: rawResult.maxNudityScore || 0,
          violence: rawResult.maxViolenceScore || 0,
          gore: rawResult.maxScores?.gore || 0,
          offensive: rawResult.maxScores?.offensive || 0,
          weapons: rawResult.maxScores?.weapon || 0,
          drugs: rawResult.maxScores?.recreational_drug || 0,
          alcohol: rawResult.maxScores?.alcohol || 0,
          tobacco: rawResult.maxScores?.tobacco || 0,
          gambling: rawResult.maxScores?.gambling || 0,
          selfHarm: rawResult.maxScores?.self_harm || 0,
          aiGenerated: rawResult.maxAiGeneratedScore || rawResult.maxScores?.ai_generated || 0,
          deepfake: rawResult.maxScores?.deepfake || 0
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
