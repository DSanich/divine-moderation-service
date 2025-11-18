// ABOUTME: AWS Rekognition provider adapter for pluggable moderation architecture
// ABOUTME: Implements BaseModerationProvider interface with async video processing

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithRekognition } from './client.mjs';
import { normalizeRekognitionResponse } from './normalizer.mjs';

export class AWSRekognitionProvider extends BaseModerationProvider {
  constructor() {
    super('aws-rekognition', {
      ...STANDARD_CAPABILITIES,
      customModels: true,
      humanReview: true,  // A2I integration available
      asyncProcessing: true,
      maxFileSizeMB: 10240, // 10GB
      maxDurationMinutes: 360, // 6 hours
      aiGenerated: false, // AWS doesn't detect AI-generated content
      deepfake: false     // AWS doesn't detect deepfakes
    });
  }

  /**
   * Check if AWS Rekognition is configured
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    return !!(
      env.AWS_ACCESS_KEY_ID &&
      env.AWS_SECRET_ACCESS_KEY &&
      env.AWS_REGION &&
      env.AWS_S3_BUCKET
    );
  }

  /**
   * Moderate video with AWS Rekognition
   * @param {string} videoUrl - Public URL to video
   * @param {Object} metadata - Video metadata (sha256, etc)
   * @param {Object} env - Environment with AWS credentials
   * @param {Object} options - Moderation options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[AWS Rekognition] Starting moderation for ${metadata.sha256}`);

      // Call AWS Rekognition API (upload, start job, poll)
      const rawResult = await moderateVideoWithRekognition(
        videoUrl,
        metadata,
        env,
        {
          minConfidence: options.minConfidence || 70,
          maxWaitMs: options.maxWaitMs || 120000, // 2 minutes
          ...options
        },
        options.fetchFn
      );

      // Normalize AWS response to standard format
      const normalized = normalizeRekognitionResponse(rawResult);

      const processingTime = Date.now() - startTime;
      console.log(`[AWS Rekognition] Completed in ${processingTime}ms`);

      return {
        ...normalized,
        provider: this.name,
        processingTime,
        raw: rawResult
      };

    } catch (error) {
      console.error(`[AWS Rekognition] Moderation failed:`, error);
      throw new Error(`AWS Rekognition moderation failed: ${error.message}`);
    }
  }
}
