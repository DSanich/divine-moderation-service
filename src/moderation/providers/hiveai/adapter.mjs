// ABOUTME: Hive.AI provider adapter for pluggable moderation architecture
// ABOUTME: Specialized provider for AI-generated content and deepfake detection

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithHiveAI } from './client.mjs';
import { normalizeHiveAIResponse } from './normalizer.mjs';

export class HiveAIProvider extends BaseModerationProvider {
  constructor() {
    super('hiveai', {
      ...STANDARD_CAPABILITIES,
      // Hive.AI specialized capabilities
      ai_generated: true,       // ✓ Primary feature: AI-generated detection
      deepfake: true,           // ✓ Primary feature: Deepfake detection
      textOcr: false,           // ✗ Not part of AI-generated detection model
      qrCode: false,            // ✗ Not part of AI-generated detection model

      // Standard moderation (not supported by AI-detection model)
      nudity: false,
      violence: false,
      gore: false,
      offensive: false,
      weapons: false,
      drugs: false,
      alcohol: false,
      tobacco: false,
      gambling: false,
      selfHarm: false,

      // Technical capabilities
      asyncProcessing: true,    // Hive.AI supports both sync and async
      liveStream: false,        // Not for live streams
      customModels: true,       // Hive.AI supports 60+ generative models

      // Supported input
      maxFileSizeMB: null,      // Check Hive.AI docs for limits
      maxDurationMinutes: null, // Check Hive.AI docs for limits
      supportedFormats: ['mp4', 'webm', 'avi', 'mkv', 'wmv', 'mov']
    });
  }

  /**
   * Check if Hive.AI V2 is configured
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    return !!(env.HIVE_API_KEY);
  }

  /**
   * Moderate video with Hive.AI AI-generated detection
   * @param {string} videoUrl - Public URL to video
   * @param {Object} metadata - Video metadata (sha256, etc)
   * @param {Object} env - Environment with Hive.AI credentials
   * @param {Object} options - Moderation options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[HiveAI] Starting AI-generated detection for ${metadata.sha256}`);

      // Call Hive.AI API
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
