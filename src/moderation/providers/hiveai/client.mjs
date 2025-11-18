// ABOUTME: Hive.AI API client for AI-generated content detection
// ABOUTME: Uses Hive.AI V2 API with models array for ai_generated_media and deepfake

/**
 * Moderate video using Hive.AI V2 AI-generated content and deepfake detection
 *
 * Hive.AI provides specialized detection for:
 * - AI-generated content (ai_generated_media model)
 * - Deepfake detection (deepfake model)
 * - Source identification (Sora, Pika, Haiper, Kling, Luma, Hedra, Runway, etc.)
 *
 * Recommended thresholds (from Hive.AI docs):
 * - AI-Generated: 0.9 on any frame
 * - Deepfake: 0.5 on two consecutive frames, or 5% of all frames
 *
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} metadata - Video metadata (sha256, etc)
 * @param {Object} env - Environment with Hive.AI credentials
 * @param {Object} options - Options (fetchFn for testing)
 * @returns {Promise<Object>} Raw Hive.AI API response
 */
export async function moderateVideoWithHiveAI(videoUrl, metadata, env, options = {}) {
  const fetchFn = options.fetchFn || fetch;

  // Hive.AI V2 API endpoint (NOTE: api.thehive.ai, NOT api.hivemoderation.com)
  const endpoint = 'https://api.thehive.ai/api/v2/task/sync';

  // Build form data (V2 uses form-urlencoded, NOT JSON)
  const formData = new FormData();
  formData.append('url', videoUrl);

  console.log('[HiveAI] Submitting video for AI-generated and deepfake detection (V2):', videoUrl);

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `token ${env.HIVE_API_KEY}`,
      'accept': 'application/json'
      // NOTE: Don't set content-type - FormData sets it automatically with boundary
    },
    body: formData
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Hive.AI V2 API error: ${response.status} ${error}`);
  }

  const data = await response.json();

  console.log('[HiveAI] Received V2 response');

  return data;
}
