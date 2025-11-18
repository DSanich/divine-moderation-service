// ABOUTME: Normalizes BunnyCDN content tags to standard format
// ABOUTME: Maps BunnyCDN categories (adult, sports, etc.) to Divine's schema

/**
 * Normalize BunnyCDN content tags to standard format
 *
 * BunnyCDN provides tags like: adult, sports, people, games, movie
 * We map these to our standard moderation categories
 *
 * @param {Object} bunnyResult - Raw BunnyCDN result with tags
 * @returns {Object} Normalized moderation result
 */
export function normalizeBunnyCDNResponse(bunnyResult) {
  const tags = bunnyResult.tags || [];

  const scores = {
    nudity: 0,
    violence: 0,
    gore: 0,
    offensive: 0,
    weapons: 0,
    drugs: 0,
    alcohol: 0,
    tobacco: 0,
    gambling: 0,
    selfHarm: 0,
    aiGenerated: 0,
    deepfake: 0
  };

  const details = {
    nudity: {},
    violence: {},
    bunnyTags: []  // Store original BunnyCDN tags
  };

  const flaggedFrames = [];

  // Parse BunnyCDN tags (extracted from metaTags array)
  // Tags are simple strings: ['adult', 'sports', 'people']
  // BunnyCDN doesn't provide confidence scores, so we use 1.0

  let parsedTags = [];

  if (typeof tags === 'string') {
    // String format: 'adult,sports'
    parsedTags = tags.split(',').map(t => ({ name: t.trim(), confidence: 1.0 }));
  } else if (Array.isArray(tags)) {
    parsedTags = tags.map(tag => {
      if (typeof tag === 'string') {
        return { name: tag, confidence: 1.0 };
      } else if (typeof tag === 'object' && tag.name) {
        return { name: tag.name, confidence: tag.confidence || tag.score || 1.0 };
      }
      return null;
    }).filter(Boolean);
  }

  // Store all tags in details for debugging
  details.bunnyTags = parsedTags;

  // Map BunnyCDN categories to our standard categories
  for (const tag of parsedTags) {
    const category = mapBunnyCategory(tag.name);
    const confidence = parseFloat(tag.confidence) || 1.0;

    if (category) {
      scores[category] = Math.max(scores[category], confidence);
    }
  }

  // BunnyCDN doesn't provide frame-level data, so we flag at video level
  // If adult content detected, create a single flagged "frame" for the video
  if (scores.nudity > 0.7) {
    flaggedFrames.push({
      position: 0,  // Entire video
      primaryConcern: 'nudity',
      primaryScore: scores.nudity,
      scores: { nudity: scores.nudity }
    });
  }

  return {
    scores,
    details,
    flaggedFrames
  };
}

/**
 * Map BunnyCDN category names to our standard categories
 *
 * Based on BunnyCDN blog post, categories include:
 * - adult (main category for moderation)
 * - sports, people, games, movie (other categories)
 * - Subcategories: soccer, tennis, racing, etc.
 *
 * @param {string} bunnyCategory - BunnyCDN category name
 * @returns {string|null} Mapped category or null
 */
function mapBunnyCategory(bunnyCategory) {
  const normalized = bunnyCategory.toLowerCase().trim();

  const categoryMap = {
    // Adult content (primary moderation concern)
    'adult': 'nudity',
    'adult_content': 'nudity',
    'sexual': 'nudity',
    'sexual_content': 'nudity',
    'nudity': 'nudity',
    'nsfw': 'nudity',

    // Violence (if BunnyCDN adds this)
    'violence': 'violence',
    'violent': 'violence',
    'gore': 'gore',
    'gory': 'gore',

    // Weapons (if BunnyCDN adds this)
    'weapon': 'weapons',
    'weapons': 'weapons',
    'gun': 'weapons',
    'knife': 'weapons',

    // Drugs (if BunnyCDN adds this)
    'drug': 'drugs',
    'drugs': 'drugs',
    'narcotic': 'drugs',

    // Alcohol (if BunnyCDN adds this)
    'alcohol': 'alcohol',
    'alcoholic': 'alcohol',
    'drinking': 'alcohol',

    // Gambling (if BunnyCDN adds this)
    'gambling': 'gambling',
    'casino': 'gambling',

    // Categories we DON'T map (non-moderation)
    // 'sports', 'people', 'games', 'movie' -> null
  };

  return categoryMap[normalized] || null;
}
