// ABOUTME: BunnyCDN provider adapter for pluggable moderation architecture
// ABOUTME: Stub implementation - complete once BunnyCDN API details are available

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithBunnyCDN } from './client.mjs';
import { normalizeBunnyCDNResponse } from './normalizer.mjs';

export class BunnyCDNProvider extends BaseModerationProvider {
  constructor() {
    super('bunnycdn', {
      ...STANDARD_CAPABILITIES,
      // TODO: Update capabilities once BunnyCDN features are confirmed
      aiGenerated: false,  // Unknown if BunnyCDN detects AI
      deepfake: false,     // Unknown if BunnyCDN detects deepfakes
      textOcr: false,      // Unknown if BunnyCDN has OCR
      qrCode: false,       // Unknown if BunnyCDN scans QR codes
      asyncProcessing: false,  // Likely synchronous
      liveStream: true     // BunnyCDN does live streaming
    });
  }

  /**
   * Check if BunnyCDN is configured
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    return !!(
      env.BUNNY_API_KEY &&
      env.BUNNY_LIBRARY_ID
    );
  }

  /**
   * Moderate video with BunnyCDN
   * @param {string} videoUrl - Public URL to video (on BunnyCDN)
   * @param {Object} metadata - Video metadata (sha256, etc)
   * @param {Object} env - Environment with BunnyCDN credentials
   * @param {Object} options - Moderation options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[BunnyCDN] Starting moderation for ${metadata.sha256}`);

      // Call BunnyCDN API
      const rawResult = await moderateVideoWithBunnyCDN(
        videoUrl,
        metadata,
        env,
        options
      );

      // Normalize response to standard format
      const normalized = normalizeBunnyCDNResponse(rawResult);

      const processingTime = Date.now() - startTime;
      console.log(`[BunnyCDN] Completed in ${processingTime}ms`);

      return {
        ...normalized,
        provider: this.name,
        processingTime,
        raw: rawResult
      };

    } catch (error) {
      console.error(`[BunnyCDN] Moderation failed:`, error.message);

      // If error is "not yet implemented", provide helpful message
      if (error.message.includes('not yet implemented')) {
        throw new Error(`BunnyCDN provider not configured. See src/moderation/providers/bunnycdn/client.mjs for setup instructions.`);
      }

      throw new Error(`BunnyCDN moderation failed: ${error.message}`);
    }
  }
}
