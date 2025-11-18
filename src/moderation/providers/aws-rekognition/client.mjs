// ABOUTME: AWS Rekognition API client for video content moderation
// ABOUTME: Handles async job submission, polling, and result retrieval

/**
 * Upload video to S3 for Rekognition processing
 * @param {string} videoUrl - Public URL to video
 * @param {string} sha256 - Video hash for S3 key
 * @param {Object} env - Environment with AWS credentials
 * @param {Function} fetchFn - Fetch function for downloading video
 * @returns {Promise<Object>} S3 location
 */
export async function uploadVideoToS3(videoUrl, sha256, env, fetchFn = fetch) {
  // Download video from URL
  const response = await fetchFn(videoUrl);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const videoBuffer = await response.arrayBuffer();

  // Upload to S3
  const s3Url = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${sha256}.mp4`;

  const uploadResponse = await fetchFn(s3Url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'x-amz-acl': 'private'
    },
    body: videoBuffer
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload to S3: ${uploadResponse.status}`);
  }

  return {
    bucket: env.AWS_S3_BUCKET,
    key: `${sha256}.mp4`
  };
}

/**
 * Start content moderation job on AWS Rekognition
 * @param {Object} s3Location - S3 bucket and key
 * @param {Object} env - Environment with AWS credentials
 * @param {number} minConfidence - Minimum confidence threshold (0-100)
 * @returns {Promise<string>} Job ID
 */
export async function startModerationJob(s3Location, env, minConfidence = 70) {
  const endpoint = `https://rekognition.${env.AWS_REGION}.amazonaws.com/`;

  const payload = {
    Video: {
      S3Object: {
        Bucket: s3Location.bucket,
        Name: s3Location.key
      }
    },
    MinConfidence: minConfidence
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'RekognitionService.StartContentModeration',
      'Authorization': await getAWSAuth(env, payload)
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AWS Rekognition error: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.JobId;
}

/**
 * Poll for moderation job results
 * @param {string} jobId - Rekognition job ID
 * @param {Object} env - Environment with AWS credentials
 * @param {number} maxWaitMs - Maximum time to wait for job
 * @param {number} pollIntervalMs - Time between polls
 * @returns {Promise<Object>} Moderation results
 */
export async function pollModerationResults(
  jobId,
  env,
  maxWaitMs = 120000, // 2 minutes
  pollIntervalMs = 2000 // 2 seconds
) {
  const endpoint = `https://rekognition.${env.AWS_REGION}.amazonaws.com/`;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const payload = { JobId: jobId };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'RekognitionService.GetContentModeration',
        'Authorization': await getAWSAuth(env, payload)
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`AWS Rekognition polling error: ${response.status} ${error}`);
    }

    const data = await response.json();

    if (data.JobStatus === 'SUCCEEDED') {
      return data;
    } else if (data.JobStatus === 'FAILED') {
      throw new Error(`Moderation job failed: ${data.StatusMessage}`);
    }

    // Still IN_PROGRESS, wait and poll again
    await sleep(pollIntervalMs);
  }

  throw new Error(`Moderation job timed out after ${maxWaitMs}ms`);
}

/**
 * Moderate video using AWS Rekognition (full flow)
 * @param {string} videoUrl - Public URL to video
 * @param {Object} metadata - Video metadata (sha256, etc)
 * @param {Object} env - Environment with AWS credentials
 * @param {Object} options - Options (minConfidence, maxWait, etc)
 * @param {Function} fetchFn - Fetch function
 * @returns {Promise<Object>} Raw Rekognition results
 */
export async function moderateVideoWithRekognition(
  videoUrl,
  metadata,
  env,
  options = {},
  fetchFn = fetch
) {
  const { sha256 } = metadata;
  const minConfidence = options.minConfidence || 70;
  const maxWaitMs = options.maxWaitMs || 120000;

  // Step 1: Upload video to S3
  console.log(`[AWS] Uploading video ${sha256} to S3...`);
  const s3Location = await uploadVideoToS3(videoUrl, sha256, env, fetchFn);

  // Step 2: Start moderation job
  console.log(`[AWS] Starting moderation job for ${sha256}...`);
  const jobId = await startModerationJob(s3Location, env, minConfidence);

  // Step 3: Poll for results
  console.log(`[AWS] Polling for results (job ${jobId})...`);
  const results = await pollModerationResults(jobId, env, maxWaitMs);

  console.log(`[AWS] Moderation complete for ${sha256}`);
  return results;
}

/**
 * Generate AWS signature v4 auth header
 * @param {Object} env - Environment with credentials
 * @param {Object} payload - Request payload
 * @returns {Promise<string>} Authorization header value
 */
async function getAWSAuth(env, payload) {
  // Simplified - in production, use AWS SDK or proper signing library
  // For Cloudflare Workers, consider using @aws-sdk/signature-v4

  // For now, returning placeholder - you'll need to implement proper AWS sig v4
  // Or use AWS SDK client
  throw new Error('AWS authentication not yet implemented - use AWS SDK');
}

/**
 * Sleep helper
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
