// ABOUTME: Base provider interface that all moderation adapters extend
// ABOUTME: Defines standard capabilities and method signatures for providers

/**
 * Standard capabilities template for all providers
 */
export const STANDARD_CAPABILITIES = {
  // Detection capabilities
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
  aiGenerated: false,
  deepfake: false,
  textOcr: false,
  qrCode: false,

  // Technical capabilities
  customModels: false,
  liveStream: false,
  humanReview: false,
  asyncProcessing: false,

  // Supported input
  maxFileSizeMB: null,
  maxDurationMinutes: null,
  supportedFormats: ['mp4', 'mov', 'avi', 'webm']
};

/**
 * Base provider class that all adapters extend
 */
export class BaseModerationProvider {
  /**
   * @param {string} name - Provider identifier (e.g., 'aws-rekognition')
   * @param {Object} capabilities - What this provider can detect
   */
  constructor(name, capabilities) {
    this.name = name;
    this.capabilities = { ...STANDARD_CAPABILITIES, ...capabilities };
  }

  /**
   * Check if provider is configured with necessary credentials
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    throw new Error('isConfigured() must be implemented by provider');
  }

  /**
   * Moderate video and return normalized result
   * @param {string} videoUrl - Public URL to video file
   * @param {Object} metadata - Video metadata (sha256, etc)
   * @param {Object} env - Environment variables with API credentials
   * @param {Object} options - Provider-specific options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    throw new Error('moderate() must be implemented by provider');
  }

  /**
   * Get provider information
   * @returns {Object}
   */
  getInfo() {
    return {
      name: this.name,
      capabilities: this.capabilities
    };
  }
}

/**
 * @typedef {Object} NormalizedModerationResult
 * @property {string} provider - Provider name
 * @property {number} processingTime - Time in milliseconds
 * @property {Object} scores - Normalized category scores (0.0-1.0)
 * @property {Object} details - Detailed subcategory scores
 * @property {Array} flaggedFrames - Frames exceeding thresholds
 * @property {Object} raw - Original provider response
 */
