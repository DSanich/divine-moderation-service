// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Complete moderation pipeline orchestration
// ABOUTME: Coordinates video analysis and classification using pluggable providers

import { moderateWithFallback } from './providers/index.mjs';
import { classifyModerationResult, getKVThresholds, kvThresholdsToEnv } from './classifier.mjs';
import { classifyText, parseVttText } from './text-classifier.mjs';
import { interpretVideoSealPayload } from './videoseal.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata, isOriginalVine, hasStrongOriginalVineEvidence } from '../nostr/relay-client.mjs';
import { classifyVideo } from '../classification/pipeline.mjs';
import { extractTopics } from '../classification/topic-extractor.mjs';
import { verifyC2pa } from './inquisitor-client.mjs';

const ORIGINAL_VINE_SUPPRESSED_CATEGORIES = new Set(['ai_generated', 'deepfake']);
const DOWNSTREAM_SIGNAL_THRESHOLD = 0.5;
const ARCHIVE_ORIGINAL_VINE_SOURCES = new Set(['archive-export', 'incident-backfill', 'sha-list']);
const C2PA_CACHE_PREFIX = 'c2pa:';
const C2PA_CACHE_TTL = 30 * 86400;

async function getCachedC2paOrVerify({ sha256, videoUrl, env, fetchFn }) {
  if (env.MODERATION_KV) {
    try {
      const cached = await env.MODERATION_KV.get(`${C2PA_CACHE_PREFIX}${sha256}`);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.warn(`[C2PA] KV read failed for ${sha256}: ${err.message}`);
    }
  }

  const result = await verifyC2pa({ url: videoUrl, mimeType: 'video/mp4' }, env, { fetchFn });

  if (env.MODERATION_KV && result.state !== 'unchecked') {
    try {
      await env.MODERATION_KV.put(`${C2PA_CACHE_PREFIX}${sha256}`, JSON.stringify(result), {
        expirationTtl: C2PA_CACHE_TTL,
      });
    } catch (err) {
      console.warn(`[C2PA] KV write failed for ${sha256}: ${err.message}`);
    }
  }

  return result;
}

function buildSignedAiShortCircuitResult({ sha256, uploadedBy, uploadedAt, metadata, videoUrl, nostrContext, nostrEventId, c2pa, videoseal }) {
  const claimGenerator = c2pa.claimGenerator || 'unknown';
  const reason = `c2pa-ai-signed:${claimGenerator} — quarantined pending moderator review`;
  return {
    action: 'QUARANTINE',
    severity: 'high',
    category: 'ai_generated',
    reason,
    requiresSecondaryVerification: false,
    scores: { ai_generated: 1.0, deepfake: 0 },
    provider: 'inquisitor-c2pa',
    processingTime: 0,
    detailedCategories: null,
    sha256,
    uploadedBy,
    uploadedAt,
    metadata,
    cdnUrl: videoUrl,
    nostrEventId,
    nostrContext,
    policyContext: {
      originalVine: false,
      originalVineLegacyFallback: false,
      enforcementOverridden: true,
      overrideReason: 'c2pa-ai-signed-short-circuit',
      originalAction: 'QUARANTINE',
    },
    downstreamSignals: {
      hasSignals: true,
      scores: { ai_generated: 1.0 },
      primaryConcern: 'ai_generated',
      category: 'ai_generated',
      severity: 'high',
      reason: `C2PA signature declares AI origin (claim_generator=${claimGenerator})`,
    },
    text_scores: null,
    providerRaw: null,
    rawClassifierData: null,
    sceneClassification: null,
    topicProfile: null,
    c2pa,
    videoseal,
  };
}

function parseOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseOptionalInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getRetryAfterSeconds(response) {
  if (typeof response?.headers?.get !== 'function') {
    return null;
  }

  const value = response.headers.get('Retry-After');
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildQueueMetadataNostrContext(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const source = parseOptionalString(metadata.source);
  const publishedAt = parseOptionalInteger(metadata.publishedAt ?? metadata.published_at);
  const context = {
    title: parseOptionalString(metadata.title),
    author: parseOptionalString(metadata.author),
    platform: parseOptionalString(metadata.platform),
    client: parseOptionalString(metadata.client),
    loops: parseOptionalInteger(metadata.loops),
    likes: parseOptionalInteger(metadata.likes),
    comments: parseOptionalInteger(metadata.comments),
    url: parseOptionalString(metadata.videoUrl ?? metadata.url),
    sourceUrl: parseOptionalString(metadata.sourceUrl ?? metadata.source_url ?? metadata.r),
    publishedAt: ARCHIVE_ORIGINAL_VINE_SOURCES.has(source) ? publishedAt : null,
    archivedAt: parseOptionalString(metadata.archivedAt ?? metadata.archived_at),
    importedAt: parseOptionalInteger(metadata.importedAt ?? metadata.imported_at),
    vineHashId: parseOptionalString(metadata.vineHashId ?? metadata.vine_hash_id ?? metadata.vine_id),
    vineUserId: parseOptionalString(metadata.vineUserId ?? metadata.vine_user_id),
    content: parseOptionalString(metadata.content),
    eventId: parseOptionalString(metadata.eventId ?? metadata.event_id),
    createdAt: parseOptionalInteger(metadata.createdAt ?? metadata.created_at)
  };

  if (
    context.platform === 'vine'
    || (context.client && /vine-(archive-importer|archaeologist)/.test(context.client))
    || context.vineHashId
    || (context.sourceUrl && context.sourceUrl.includes('vine.co'))
  ) {
    context.publishedAt = publishedAt;
  }

  return Object.values(context).some((value) => value !== null) ? context : null;
}

function applyOriginalVineEnforcementOverride(classification) {
  return {
    ...classification,
    action: 'SAFE',
    severity: 'low',
    category: null,
    reason: 'Original Vine archive content remains serveable; moderation signals retained for trust and safety context',
    requiresSecondaryVerification: false
  };
}

function deriveDownstreamSignals(classification, { originalVine = false } = {}) {
  const sourceScores = classification?.scores || {};
  const filteredScores = {};

  for (const [category, score] of Object.entries(sourceScores)) {
    const shouldSuppress = originalVine && ORIGINAL_VINE_SUPPRESSED_CATEGORIES.has(category);
    filteredScores[category] = shouldSuppress ? 0 : score;
  }

  const signalEntries = Object.entries(filteredScores)
    .filter(([, score]) => score >= DOWNSTREAM_SIGNAL_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);

  const primaryConcern = signalEntries[0]?.[0] || null;
  const primaryScore = signalEntries[0]?.[1] || 0;

  return {
    hasSignals: signalEntries.length > 0,
    scores: filteredScores,
    primaryConcern,
    category: primaryConcern,
    severity: primaryScore >= 0.8 ? 'high' : (primaryScore > 0 ? 'medium' : 'low'),
    reason: primaryConcern
      ? `Moderation signal retained for ${primaryConcern}`
      : null
  };
}

/**
 * Run classify-only pipeline on a video that already has moderation results.
 * Skips expensive HiveAI moderation + Sightengine calls. Only runs:
 *   - VLM scene classification (Hive VLM)
 *   - VTT topic extraction
 *
 * @param {string} sha256 - Video hash
 * @param {Object} env - Environment variables
 * @param {Object} [options] - Options
 * @param {string} [options.videoUrl] - Explicit video URL (skips Nostr/CDN resolution)
 * @param {Function} [options.fetchFn] - Fetch function (for testing)
 * @returns {Promise<Object>} { sceneClassification, topicProfile, sha256 }
 */
export async function classifyVideoOnly(sha256, env, options = {}) {
  const fetchFn = options.fetchFn || fetch;

  if (!options.videoUrl && !env.CDN_DOMAIN) {
    throw new Error('CDN_DOMAIN not configured and no videoUrl provided');
  }

  // Resolve video URL — use explicit URL, or try Nostr metadata, fall back to CDN
  let videoUrl = options.videoUrl || `https://${env.CDN_DOMAIN}/${sha256}`;
  if (!options.videoUrl) {
    try {
      const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
      const event = await fetchNostrEventBySha256(sha256, relays);
      if (event) {
        const nostrContext = parseVideoEventMetadata(event);
        if (nostrContext.url) {
          videoUrl = nostrContext.url;
          console.log(`[CLASSIFY-ONLY] Using video URL from Nostr event for ${sha256}: ${videoUrl}`);
        }
      }
    } catch (error) {
      console.log(`[CLASSIFY-ONLY] Nostr lookup failed for ${sha256}, using CDN fallback: ${error.message}`);
    }
  } else {
    console.log(`[CLASSIFY-ONLY] Using provided video URL for ${sha256}: ${videoUrl}`);
  }

  // Run VLM scene classification and VTT topic extraction in parallel
  const [sceneResult, topicResult] = await Promise.allSettled([
    // Scene classification via Hive VLM
    (async () => {
      try {
        const result = await classifyVideo(videoUrl, env, { sha256, fetchFn });
        if (result && !result.skipped) {
          console.log(`[CLASSIFY-ONLY] Scene classification complete for ${sha256}: ${result.labels?.length || 0} labels`);
          return result;
        }
        console.log(`[CLASSIFY-ONLY] Scene classification skipped for ${sha256}: ${result?.reason || 'unknown'}`);
        return null;
      } catch (error) {
        console.error(`[CLASSIFY-ONLY] Scene classification failed for ${sha256}: ${error.message}`);
        return null;
      }
    })(),
    // VTT topic extraction
    (async () => {
      try {
        const vttUrl = `https://media.divine.video/${sha256}.vtt`;
        const vttResponse = await fetchFn(vttUrl);
        if (vttResponse.status === 202) {
          const retryAfterSeconds = getRetryAfterSeconds(vttResponse);
          console.log(`[CLASSIFY-ONLY] VTT transcript for ${sha256} is still pending${retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ''}`);
          return null;
        }
        if (vttResponse.status === 404) {
          console.log(`[CLASSIFY-ONLY] No VTT transcript for ${sha256} (404)`);
          return null;
        }
        if (!vttResponse.ok) {
          console.warn(`[CLASSIFY-ONLY] VTT fetch returned ${vttResponse.status} for ${sha256}`);
          return null;
        }
        const vttContent = await vttResponse.text();
        const { parseVttText } = await import('./text-classifier.mjs');
        const plainText = parseVttText(vttContent);
        if (plainText.trim().length > 0) {
          const profile = extractTopics(plainText);
          console.log(`[CLASSIFY-ONLY] Topic extraction for ${sha256}: primary_topic=${profile.primary_topic}, ${profile.topics.length} topics`);
          return profile;
        }
        console.log(`[CLASSIFY-ONLY] VTT transcript for ${sha256} contains no extractable text`);
        return null;
      } catch (error) {
        console.error(`[CLASSIFY-ONLY] VTT/topic extraction failed for ${sha256}: ${error.message}`);
        return null;
      }
    })()
  ]);

  const sceneClassification = sceneResult.status === 'fulfilled' ? sceneResult.value : null;
  const topicProfile = topicResult.status === 'fulfilled' ? topicResult.value : null;

  return { sha256, sceneClassification, topicProfile };
}

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
  const {
    sha256,
    uploadedBy,
    uploadedAt,
    metadata,
    videoSealPayload = null,
    videoSealBitAccuracy = null
  } = videoData;

  // Validate configuration
  if (!env.CDN_DOMAIN) {
    throw new Error('CDN_DOMAIN not configured');
  }

  // Step 1: Determine video URL - prefer metadata.videoUrl if provided (e.g., from relay-poller)
  const queueNostrContext = buildQueueMetadataNostrContext(metadata);
  let nostrContext = queueNostrContext;
  let videoUrl = metadata?.videoUrl || queueNostrContext?.url || `https://${env.CDN_DOMAIN}/${sha256}`; // Default: blossom content-addressed URL
  let nostrEventId = queueNostrContext?.eventId || metadata?.eventId || metadata?.event_id || null;

  // Always attempt to resolve Nostr context so policy decisions can use archive metadata
  try {
    const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
    const event = await fetchNostrEventBySha256(sha256, relays);
    if (event) {
      const relayNostrContext = parseVideoEventMetadata(event);
      nostrContext = queueNostrContext
        ? { ...queueNostrContext, ...relayNostrContext }
        : relayNostrContext;
      nostrEventId = event.id;
      console.log(`[MODERATION] Found Nostr context for ${sha256}:`, nostrContext);

      // Prefer explicit metadata.videoUrl when provided, otherwise trust the relay URL
      if (!metadata?.videoUrl && nostrContext.url) {
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

  if (metadata?.videoUrl) {
    console.log(`[MODERATION] Using video URL from metadata: ${videoUrl}`);
  } else {
    console.log(`[MODERATION] Using resolved video URL: ${videoUrl}`);
  }

  // Step 2: Check if this is an original Vine (skip AI detection for pre-2018 content)
  const skipAIDetection = isOriginalVine(nostrContext);
  const shouldForceServeable = hasStrongOriginalVineEvidence(nostrContext);
  if (skipAIDetection) {
    console.log(`[MODERATION] Original Vine detected - skipping AI detection for ${sha256}`);
  }

  // Step 2.5: Call divine-inquisitor first so valid_ai_signed content can short-circuit Hive
  const c2pa = await getCachedC2paOrVerify({ sha256, videoUrl, env, fetchFn });
  console.log(`[MODERATION] ${sha256} - C2PA state: ${c2pa.state}${c2pa.claimGenerator ? ` (claim=${c2pa.claimGenerator})` : ''}`);
  const videoseal = interpretVideoSealPayload(videoSealPayload, videoSealBitAccuracy);

  if (c2pa.state === 'valid_ai_signed') {
    console.log(`[MODERATION] ${sha256} - signed-AI short-circuit, skipping Hive and Reality Defender`);
    return buildSignedAiShortCircuitResult({
      sha256, uploadedBy, uploadedAt, metadata,
      videoUrl, nostrContext, nostrEventId, c2pa, videoseal,
    });
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
    if (vttResponse.status === 202) {
      const retryAfterSeconds = getRetryAfterSeconds(vttResponse);
      console.log(`[MODERATION] VTT transcript for ${sha256} is still pending${retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ''} - skipping text analysis`);
    } else if (vttResponse.status === 404) {
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
  // Merge KV-based admin thresholds over env vars (KV takes priority)
  let effectiveEnv = env;
  try {
    const kvThresholds = await getKVThresholds(env.MODERATION_KV);
    if (kvThresholds) {
      effectiveEnv = { ...env, ...kvThresholdsToEnv(kvThresholds) };
    }
  } catch (e) {
    console.warn('[MODERATION] Failed to load KV thresholds, using env defaults:', e.message);
  }
  const classification = classifyModerationResult({
    maxScores: moderationResult.scores,
    flaggedFrames: moderationResult.flaggedFrames,
    text_scores: textScores
  }, effectiveEnv);

  const policyContext = {
    originalVine: shouldForceServeable,
    originalVineLegacyFallback: skipAIDetection && !shouldForceServeable,
    enforcementOverridden: false,
    overrideReason: null,
    originalAction: classification.action
  };

  const downstreamSignals = deriveDownstreamSignals(classification, { originalVine: shouldForceServeable });

  let finalClassification = shouldForceServeable
    ? (() => {
      const overridden = applyOriginalVineEnforcementOverride(classification);
      if (classification.action !== overridden.action) {
        policyContext.enforcementOverridden = true;
        policyContext.overrideReason = 'original-vine-serveable';
      }
      return overridden;
    })()
    : classification;

  // Step 4.25: ProofMode downgrade rule — valid ProofMode capture attestation
  // downgrades an AI-driven QUARANTINE to REVIEW so humans decide (content stays visible).
  if (
    c2pa.state === 'valid_proofmode'
    && finalClassification.action === 'QUARANTINE'
    && (finalClassification.category === 'ai_generated' || finalClassification.category === 'deepfake')
  ) {
    console.log(`[MODERATION] ${sha256} - ProofMode downgrade: QUARANTINE → REVIEW`);
    policyContext.originalAction = finalClassification.action;
    policyContext.enforcementOverridden = true;
    policyContext.overrideReason = 'proofmode-capture-authenticated';
    finalClassification = {
      ...finalClassification,
      action: 'REVIEW',
      reason: `${finalClassification.reason} | proofmode-capture-authenticated`,
      requiresSecondaryVerification: false,
    };
  }

  // Step 4.5: If AI-flagged, submit to Reality Defender for secondary verification (fire-and-forget)
  if (finalClassification.requiresSecondaryVerification && env.REALITY_DEFENDER_API_KEY) {
    try {
      const { submitToRealityDefender } = await import('./realness-client.mjs');
      const rdResult = await submitToRealityDefender(sha256, videoUrl, env);
      if (rdResult.submitted) {
        console.log(`[MODERATION] ${sha256} - Submitted to Reality Defender for secondary AI verification (requestId=${rdResult.requestId})`);
      } else if (!rdResult.cached) {
        console.warn(`[MODERATION] ${sha256} - Failed to submit to Reality Defender: ${rdResult.error}`);
      }
    } catch (err) {
      console.error(`[MODERATION] ${sha256} - Reality Defender submission error:`, err.message);
      // Non-fatal: don't block moderation if Reality Defender is unavailable
    }
  }

  // Step 5: Return complete result
  return {
    // Classification
    ...finalClassification,

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

    // Explicit policy metadata for serveability vs downstream moderation signals
    policyContext,
    downstreamSignals,

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
    topicProfile: topicProfile || null,

    // C2PA / ProofMode verification result from divine-inquisitor.
    // state ∈ {valid_proofmode, valid_c2pa, valid_ai_signed, invalid, absent, unchecked}.
    // valid_ai_signed is handled earlier via short-circuit; valid_proofmode may have
    // downgraded the action above.
    c2pa,

    // Interpreted upstream Video Seal watermark payload
    // Always present so downstream consumers can rely on a stable signal shape
    videoseal
  };
}
