// ABOUTME: BunnyCDN/Bunnystream content tagging API client
// ABOUTME: Uses BunnyCDN's automated content tagging feature (preview)

/**
 * Moderate video using BunnyCDN automated content tagging
 *
 * BunnyCDN Stream offers automated content tagging (preview feature, FREE):
 * - Categories: adult, sports, people, games, movie, + subcategories
 * - Integrated into transcoding pipeline
 * - Designed for content moderation use cases
 *
 * @param {string} videoUrl - Public URL to video (already on BunnyCDN)
 * @param {Object} metadata - Video metadata (sha256, etc)
 * @param {Object} env - Environment with BunnyCDN credentials
 * @param {Object} options - Options
 * @returns {Promise<Object>} Raw BunnyCDN content tags
 */
export async function moderateVideoWithBunnyCDN(videoUrl, metadata, env, options = {}) {
  // BunnyCDN Stream API endpoint
  // https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}

  const videoId = getVideoId(videoUrl, metadata, env);

  if (!videoId) {
    throw new Error('Could not determine BunnyCDN video ID from URL or metadata');
  }

  const endpoint = `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${videoId}`;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'AccessKey': env.BUNNY_API_KEY,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`BunnyCDN API error: ${response.status} ${error}`);
  }

  const data = await response.json();

  // BunnyCDN uses a "category" field for content tagging, not metaTags
  // Categories: adult, gaming, animated, other-people, anime, animals-cats, movie, other, untagged
  console.log('[BunnyCDN] Video category:', data.category);

  // Return category as a single-item array for consistency with normalizer
  const tags = data.category ? [data.category] : [];

  if (!tags || tags.length === 0) {
    console.warn('[BunnyCDN] No content tags found. Ensure content tagging is enabled in your video library settings.');
    console.warn('[BunnyCDN] Go to: https://panel.bunny.net/stream -> Your Library -> Settings -> Enable Content Tagging');
  }

  return {
    videoId,
    tags: tags,
    rawResponse: data
  };
}

/**
 * Get video ID from BunnyCDN URL or metadata
 * @param {string} videoUrl - https://cdn.divine.video/{sha256}.mp4
 * @param {Object} metadata - Metadata including sha256
 * @param {Object} env - Environment (may have videoId mapping)
 * @returns {string|null} Video ID for BunnyCDN API
 */
function getVideoId(videoUrl, metadata, env) {
  // Option 1: Video ID explicitly in metadata
  if (metadata.bunnyVideoId) {
    return metadata.bunnyVideoId;
  }

  // Option 2: SHA256 IS the video ID (if that's how you store them)
  if (metadata.sha256) {
    return metadata.sha256;
  }

  // Option 3: Extract from URL
  // https://cdn.divine.video/abc123.mp4 -> abc123
  const match = videoUrl.match(/\/([^\/]+)\.mp4$/);
  if (match) {
    return match[1];
  }

  // Option 4: Look up in a mapping table (if you maintain one)
  // if (env.VIDEO_ID_LOOKUP_FUNCTION) {
  //   return env.VIDEO_ID_LOOKUP_FUNCTION(metadata.sha256);
  // }

  return null;
}
