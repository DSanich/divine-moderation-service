// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Reality Defender API client for secondary AI-generated content verification
// ABOUTME: Called when Hive flags content as AI-generated to get a second opinion

const RD_API_BASE = 'https://api.prd.realitydefender.xyz';
const SUBMIT_TIMEOUT_MS = 30000;
const POLL_TIMEOUT_MS = 10000;
const KV_RESULT_TTL = 86400 * 7; // Cache results for 7 days

/**
 * Submit a video to Reality Defender for AI-generated verification.
 * Downloads the video, uploads to RD's presigned S3 URL, then stores the requestId in KV.
 *
 * @param {string} sha256 - Video hash
 * @param {string} videoUrl - URL to the video file
 * @param {Object} env - Cloudflare Workers env (needs REALITY_DEFENDER_API_KEY)
 * @returns {Promise<{ submitted: boolean, requestId?: string, error?: string }>}
 */
export async function submitToRealityDefender(sha256, videoUrl, env) {
  if (!env.REALITY_DEFENDER_API_KEY) {
    return { submitted: false, error: 'REALITY_DEFENDER_API_KEY not configured' };
  }

  try {
    // Check if we already have a result or pending submission
    if (env.MODERATION_KV) {
      const cached = await env.MODERATION_KV.get(`rd:${sha256}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.status === 'complete') {
          console.log(`[RD] Already have result for ${sha256}: ${parsed.verdict}`);
          return { submitted: false, error: 'Already have result', cached: true };
        }
        if (parsed.status === 'pending' && parsed.requestId) {
          console.log(`[RD] Already submitted ${sha256}, requestId=${parsed.requestId}`);
          return { submitted: true, requestId: parsed.requestId };
        }
      }
    }

    // Step 1: Download the video
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      return { submitted: false, error: `Failed to fetch video: ${videoResponse.status}` };
    }
    const videoBlob = await videoResponse.blob();

    // Ensure filename has a video extension (Reality Defender requires it)
    let filename = videoUrl.split('/').pop() || 'video.mp4';
    if (!filename.match(/\.(mp4|mov|avi|webm|mkv)$/i)) {
      filename = filename + '.mp4';
    }

    // Step 2: Get presigned URL from Reality Defender
    const presignedResponse = await fetch(`${RD_API_BASE}/api/files/aws-presigned`, {
      method: 'POST',
      headers: {
        'X-API-KEY': env.REALITY_DEFENDER_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'divine-moderation-service/1.0',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ fileName: filename }),
    });

    if (!presignedResponse.ok) {
      const errorText = await presignedResponse.text();
      return { submitted: false, error: `Presigned URL failed: ${presignedResponse.status} - ${errorText}` };
    }

    const presignedData = await presignedResponse.json();

    // Step 3: Upload video to the presigned S3 URL
    const uploadResponse = await fetch(presignedData.response.signedUrl, {
      method: 'PUT',
      body: videoBlob,
    });

    if (!uploadResponse.ok) {
      const uploadError = await uploadResponse.text();
      return { submitted: false, error: `S3 upload failed: ${uploadResponse.status} - ${uploadError}` };
    }

    const requestId = presignedData.requestId;

    // Store pending status in KV for later polling
    if (env.MODERATION_KV) {
      await env.MODERATION_KV.put(`rd:${sha256}`, JSON.stringify({
        status: 'pending',
        requestId,
        submittedAt: new Date().toISOString(),
      }), { expirationTtl: KV_RESULT_TTL });
    }

    console.log(`[RD] Submitted ${sha256} to Reality Defender, requestId=${requestId}`);
    return { submitted: true, requestId };
  } catch (err) {
    console.error(`[RD] Submit error for ${sha256}:`, err.message);
    return { submitted: false, error: err.message };
  }
}

/**
 * Poll Reality Defender for results of a previously submitted video.
 * Updates KV cache with the result.
 *
 * @param {string} sha256 - Video hash
 * @param {Object} env - Cloudflare Workers env
 * @returns {Promise<Object|null>} Result or null if not ready/not found
 */
export async function pollRealityDefender(sha256, env) {
  if (!env.REALITY_DEFENDER_API_KEY) {
    return null;
  }

  // Get requestId from KV
  let requestId = null;
  if (env.MODERATION_KV) {
    const cached = await env.MODERATION_KV.get(`rd:${sha256}`);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.status === 'complete') {
        return parsed; // Already have final result
      }
      requestId = parsed.requestId;
    }
  }

  if (!requestId) {
    return null;
  }

  try {
    const response = await fetch(`${RD_API_BASE}/api/media/users/${requestId}`, {
      method: 'GET',
      headers: {
        'X-API-KEY': env.REALITY_DEFENDER_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'divine-moderation-service/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[RD] Poll failed: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Check if results are ready
    const rdStatus = data.resultsSummary?.status;
    if (!rdStatus) {
      console.log(`[RD] ${sha256} still processing`);
      return { status: 'pending', requestId };
    }

    // Extract score (0-100 scale → normalized to 0-1)
    const finalScore = data.resultsSummary?.metadata?.finalScore ?? 0;
    let score = finalScore / 100;

    // Map Reality Defender status to verdict
    let verdict = 'uncertain';
    if (rdStatus === 'AUTHENTIC') {
      verdict = 'authentic';
      if (score === 0) score = 0.1;
    } else if (rdStatus === 'FAKE') {
      verdict = 'likely_ai';
      if (score === 0) score = 0.95;
    } else if (rdStatus === 'SUSPICIOUS') {
      verdict = 'likely_ai';
      if (score === 0) score = 0.7;
    }

    const result = {
      status: 'complete',
      requestId,
      provider: 'reality_defender',
      score,
      verdict,
      rdStatus,
      completedAt: new Date().toISOString(),
    };

    // Cache result in KV
    if (env.MODERATION_KV) {
      await env.MODERATION_KV.put(`rd:${sha256}`, JSON.stringify(result), {
        expirationTtl: KV_RESULT_TTL,
      });
    }

    console.log(`[RD] ${sha256} result: ${rdStatus} score=${score} verdict=${verdict}`);
    return result;
  } catch (err) {
    console.error(`[RD] Poll error for ${sha256}:`, err.message);
    return null;
  }
}

/**
 * Get the Reality Defender result for a video (from KV cache or by polling).
 * Used by the admin dashboard to display secondary verification.
 *
 * @param {string} sha256 - Video hash
 * @param {Object} env
 * @returns {Promise<Object|null>}
 */
export async function getRealnessResult(sha256, env) {
  // Check KV cache first
  if (env.MODERATION_KV) {
    const cached = await env.MODERATION_KV.get(`rd:${sha256}`);
    if (cached) {
      const parsed = JSON.parse(cached);

      // If pending, try to poll for results
      if (parsed.status === 'pending' && parsed.requestId && env.REALITY_DEFENDER_API_KEY) {
        const polled = await pollRealityDefender(sha256, env);
        if (polled && polled.status === 'complete') {
          return formatForDashboard(polled);
        }
        return formatForDashboard(parsed);
      }

      return formatForDashboard(parsed);
    }
  }

  return null;
}

/**
 * Format a Reality Defender result for the admin dashboard.
 */
function formatForDashboard(result) {
  return {
    status: result.status,
    overallVerdict: result.verdict || 'pending',
    providers: {
      reality_defender: {
        status: result.status,
        score: result.score ?? null,
        verdict: result.verdict ?? null,
        rdStatus: result.rdStatus ?? null,
      },
    },
    submittedAt: result.submittedAt,
    completedAt: result.completedAt,
  };
}
