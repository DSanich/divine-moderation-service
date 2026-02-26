// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Complete moderation pipeline orchestration
// ABOUTME: Coordinates video analysis and classification using pluggable providers

import { moderateWithFallback } from './providers/index.mjs';
import { classifyModerationResult } from './classifier.mjs';
import { classifyText, parseVttText } from './text-classifier.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata, isOriginalVine } from '../nostr/relay-client.mjs';
import { classifyVideo } from '../classification/pipeline.mjs';
import { extractTopics } from '../classification/topic-extractor.mjs';

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

  // Step 1: Determine video URL - prefer metadata.videoUrl if provided (e.g., from relay-poller)
  let nostrContext = null;
  let videoUrl = metadata?.videoUrl || `https://${env.CDN_DOMAIN}/${sha256}.mp4`; // Default fallback
  let nostrEventId = metadata?.eventId || null;

  // If we don't have a video URL from metadata, try to fetch from Nostr relay
  if (!metadata?.videoUrl) {
    try {
      const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
      const event = await fetchNostrEventBySha256(sha256, relays);
      if (event) {
        nostrContext = parseVideoEventMetadata(event);
        nostrEventId = event.id;
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
  } else {
    console.log(`[MODERATION] Using video URL from metadata: ${videoUrl}`);
  }

  // Step 2: Check if this is an original Vine (skip AI detection for pre-2018 content)
  const skipAIDetection = isOriginalVine(nostrContext);
  if (skipAIDetection) {
    console.log(`[MODERATION] Original Vine detected - skipping AI detection for ${sha256}`);
  }

  // Step 3: Run moderation and scene classification in parallel
  let moderationResult;
  let combinedScores = {};
  let combinedFlaggedFrames = [];
  let providers = [];
  let processingTime = 0;
  let rawClassifierData = null;
  let sceneClassification = null;

  // Build the moderation promise (HiveAI primary, Sightengine fallback)
  const moderationPromise = (async () => {
    try {
      console.log('[MODERATION] Running moderation with fallback chain');
      return await moderateWithFallback(
        videoUrl,
        { sha256 },
        env,
        { fetchFn, skipAIDetection }
      );
    } catch (error) {
      console.error('[MODERATION] Moderation failed:', error);
      throw error;
    }
  })();

  // Build the scene classification promise (runs in parallel with moderation)
  const sceneClassificationPromise = (async () => {
    try {
      const result = await classifyVideo(videoUrl, env, { sha256, fetchFn });
      return result;
    } catch (error) {
      console.error(`[MODERATION] Scene classification failed for ${sha256} (non-fatal):`, error.message);
      return null;
    }
  })();

  // Run moderation and scene classification in parallel
  const [moderationSettled, sceneSettled] = await Promise.allSettled([
    moderationPromise,
    sceneClassificationPromise
  ]);

  // Moderation is required — rethrow if it failed
  if (moderationSettled.status === 'rejected') {
    throw moderationSettled.reason;
  }
  moderationResult = moderationSettled.value;

  // Scene classification is optional — use null if it failed
  if (sceneSettled.status === 'fulfilled' && sceneSettled.value && !sceneSettled.value.skipped) {
    sceneClassification = sceneSettled.value;
    console.log(`[MODERATION] Scene classification complete for ${sha256}: ${sceneClassification.labels?.length || 0} labels`);
  } else if (sceneSettled.status === 'fulfilled' && sceneSettled.value?.skipped) {
    console.log(`[MODERATION] Scene classification skipped for ${sha256}: ${sceneSettled.value.reason}`);
  }

  // Step 3.5: Fetch VTT transcript and analyze text content + extract topics
  let textScores = null;
  let topicProfile = null;
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

        // Extract topics from the same VTT text (local computation, fast)
        try {
          topicProfile = extractTopics(plainText);
          console.log(`[MODERATION] Topic extraction for ${sha256}: primary_topic=${topicProfile.primary_topic}, ${topicProfile.topics.length} topics, has_speech=${topicProfile.has_speech}`);
        } catch (topicError) {
          console.error(`[MODERATION] Topic extraction failed for ${sha256} (non-fatal):`, topicError.message);
        }
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

    // Nostr event ID (for linking back to the original video event)
    nostrEventId,

    // Nostr event context (if found)
    nostrContext,

    // Text analysis scores from VTT transcript (null if no VTT available)
    text_scores: textScores,

    // Raw provider data (for debugging/auditing)
    providerRaw: moderationResult.raw,

    // Full raw classifier data from Hive AI (all classes, all frames)
    // Used by downstream recommendation systems (funnelcake, gorse)
    rawClassifierData: moderationResult.rawClassifierData || null,

    // Scene classification result from Hive AI VLM (Vision Language Model)
    // Contains topics, setting, objects, activities, mood, description, and recommendation labels
    // null if HIVE_VLM_API_KEY is not configured or classification failed
    sceneClassification: sceneClassification || null,

    // Topic profile extracted from VTT transcript text
    // Contains topics with confidence scores, primary_topic, has_speech, language_hint
    // null if no VTT transcript is available
    topicProfile: topicProfile || null
  };
}
