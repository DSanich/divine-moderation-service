// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Complete moderation pipeline orchestration
// ABOUTME: Coordinates video analysis and classification using pluggable providers

import { moderateWithFallback } from './providers/index.mjs';
import { classifyModerationResult } from './classifier.mjs';
import { classifyText, parseVttText } from './text-classifier.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata, isOriginalVine } from '../nostr/relay-client.mjs';

/**
 * Run full moderation pipeline on a video
 * @param {Object} videoData - Video information from queue message
 * @param {string} videoData.sha256 - Video hash
 * @param {string} [videoData.uploadedBy] - Uploader's nostr pubkey
 * @param {number} videoData.uploadedAt - Upload timestamp
 * @param {Object} [videoData.metadata] - Additional metadata
 * @param {Object} env - Environment variables
 * @param {Function} [fetchFn] - Fetch function (for testing)
 * @returns {Promise<Object>} Complete moderation result with classification
 */
export async function moderateVideo(videoData, env, fetchFn = fetch) {
  const { sha256, uploadedBy, uploadedAt, metadata } = videoData;

  // Validate configuration
  if (!env.CDN_DOMAIN) {
    throw new Error('CDN_DOMAIN not configured');
  }

  // Step 1: Fetch Nostr event context to get the actual video URL
  let nostrContext = null;
  let videoUrl = `https://${env.CDN_DOMAIN}/${sha256}.mp4`; // Fallback default

  try {
    const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
    const event = await fetchNostrEventBySha256(sha256, relays, env);
    if (event) {
      nostrContext = parseVideoEventMetadata(event);
      console.log(`[MODERATION] Found Nostr context for ${sha256}:`, nostrContext);

      // Use the video URL from Nostr event if available
      if (nostrContext.url) {
        videoUrl = nostrContext.url;
        console.log(`[MODERATION] Using video URL from Nostr event: ${videoUrl}`);
      }
    } else {
      console.log(`[MODERATION] No Nostr event found for ${sha256}, using fallback URL: ${videoUrl}`);
    }
  } catch (error) {
    console.error(`[MODERATION] Failed to fetch Nostr context for ${sha256}:`, error);
    console.log(`[MODERATION] Using fallback URL: ${videoUrl}`);
    // Don't fail moderation if Nostr fetch fails
  }

  // Step 2: Check if this is an original Vine (skip AI detection for pre-2018 content)
  const skipAIDetection = isOriginalVine(nostrContext);
  if (skipAIDetection) {
    console.log(`[MODERATION] Original Vine detected - skipping AI detection for ${sha256}`);
  }

  // Step 3: Run moderation with appropriate providers
  let moderationResult;
  let combinedScores = {};
  let combinedFlaggedFrames = [];
  let providers = [];
  let processingTime = 0;

  try {
    // Check which providers are configured
    const hasBunny = env.BUNNY_STREAM_API_KEY;
    const hasHive = env.HIVE_MODERATION_API_KEY || env.HIVE_AI_DETECTION_API_KEY;

    if (hasBunny && hasHive) {
      // Run both in parallel for comprehensive coverage
      console.log('[MODERATION] Running BunnyCDN and HiveAI in parallel');
      const { moderateWithMultiple } = await import('./providers/index.mjs');

      const multiResult = await moderateWithMultiple(
        videoUrl,
        { sha256 },
        env,
        ['bunnycdn', 'hiveai'],
        { fetchFn, skipAIDetection }
      );

      // Merge results from both providers
      for (const result of multiResult.results) {
        if (result.status === 'fulfilled' && result.result) {
          providers.push(result.provider);
          processingTime += result.result.processingTime || 0;

          // Merge scores (HiveAI provides aiGenerated/deepfake, BunnyCDN provides everything else)
          combinedScores = {
            ...combinedScores,
            ...result.result.scores
          };

          // Combine flagged frames
          if (result.result.flaggedFrames) {
            combinedFlaggedFrames = [...combinedFlaggedFrames, ...result.result.flaggedFrames];
          }
        }
      }

      moderationResult = {
        scores: combinedScores,
        flaggedFrames: combinedFlaggedFrames,
        provider: providers.join('+'),
        processingTime,
        details: multiResult.results.reduce((acc, r) => ({
          ...acc,
          ...(r.result?.details || {})
        }), {}),
        raw: multiResult.results.map(r => ({ provider: r.provider, data: r.result?.raw }))
      };

      console.log(`[MODERATION] Combined results from ${providers.join(' + ')}`);

    } else {
      // Fallback to single provider
      console.log('[MODERATION] Using fallback moderation (only one provider configured)');
      moderationResult = await moderateWithFallback(
        videoUrl,
        { sha256 },
        env,
        { fetchFn, skipAIDetection }
      );
    }
  } catch (error) {
    console.error('[MODERATION] Moderation failed:', error);
    throw error;
  }

  // Step 3.5: Fetch VTT transcript and analyze text content
  let textScores = null;
  try {
    const vttUrl = `https://media.divine.video/${sha256}.vtt`;
    console.log(`[MODERATION] Fetching VTT transcript: ${vttUrl}`);
    const vttResponse = await fetchFn(vttUrl);
    if (vttResponse.status === 404) {
      console.log(`[MODERATION] No VTT transcript found for ${sha256} (404) - skipping text analysis`);
    } else if (!vttResponse.ok) {
      console.warn(`[MODERATION] VTT fetch returned ${vttResponse.status} for ${sha256} - skipping text analysis`);
    } else {
      const vttContent = await vttResponse.text();
      const plainText = parseVttText(vttContent);
      if (plainText.trim().length > 0) {
        textScores = classifyText(plainText);
        console.log(`[MODERATION] Text analysis scores for ${sha256}:`, textScores);
      } else {
        console.log(`[MODERATION] VTT transcript for ${sha256} contains no extractable text`);
      }
    }
  } catch (error) {
    console.error(`[MODERATION] Failed to fetch/analyze VTT for ${sha256}:`, error);
    // Don't fail moderation if VTT analysis fails
  }

  // Step 4: Classify result into action categories
  const classification = classifyModerationResult({
    maxScores: moderationResult.scores,
    flaggedFrames: moderationResult.flaggedFrames,
    text_scores: textScores
  }, env);

  // Step 5: Return complete result
  return {
    // Classification
    ...classification,

    // Provider used
    provider: moderationResult.provider,
    processingTime: moderationResult.processingTime,

    // Detailed subcategories for fine-grained filtering
    detailedCategories: moderationResult.details,

    // Video metadata
    sha256,
    uploadedBy,
    uploadedAt,
    metadata,

    // CDN URL for reference
    cdnUrl: videoUrl,

    // Nostr event context (if found)
    nostrContext,

    // Text analysis scores from VTT transcript (null if no VTT available)
    text_scores: textScores,

    // Raw provider data (for debugging/auditing)
    providerRaw: moderationResult.raw
  };
}
