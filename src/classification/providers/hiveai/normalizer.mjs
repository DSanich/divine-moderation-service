// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Normalizes Hive VLM (Vision Language Model) classification responses
// ABOUTME: Parses structured JSON from VLM into labels, features, and description

/**
 * Known topic categories that map cleanly to recommendation label namespaces.
 *
 * The VLM returns free-form topic strings.  We normalise them to lower-case
 * kebab-style so downstream consumers (funnelcake, gorse) get a stable vocabulary.
 */
export const KNOWN_TOPICS = new Set([
  'music', 'comedy', 'dance', 'sports', 'food', 'animals', 'fashion',
  'art', 'education', 'gaming', 'nature', 'technology', 'travel',
  'fitness', 'news', 'beauty', 'diy', 'automotive', 'pets', 'family',
  'cooking', 'entertainment', 'health', 'science', 'politics',
  'photography', 'crafts', 'gardening', 'film', 'movies', 'television',
  'shopping', 'real-estate', 'religion', 'spirituality', 'vlog',
  'tutorial', 'review', 'unboxing', 'prank', 'challenge', 'reaction',
  'asmr', 'meditation', 'yoga', 'martial-arts', 'skateboarding',
  'surfing', 'skiing', 'snowboarding', 'cycling', 'running',
  'swimming', 'basketball', 'football', 'soccer', 'baseball',
  'tennis', 'golf', 'boxing', 'wrestling', 'mma'
]);

/**
 * Normalise a single string value: lower-case, trim, replace spaces with hyphens.
 */
function normalizeString(str) {
  return (str || '').toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * Extract the structured classification from a VLM chat completion response.
 *
 * The VLM returns an OpenAI-compatible response where the classification
 * is a JSON string inside `choices[0].message.content`.
 *
 * @param {Object} rawResponse - Raw Hive VLM chat completion response
 * @returns {Object} Parsed classification with topics, setting, objects, activities, mood, description
 */
export function parseVLMContent(rawResponse) {
  const empty = {
    topics: [],
    setting: '',
    objects: [],
    activities: [],
    mood: '',
    description: ''
  };

  if (!rawResponse?.choices?.[0]?.message?.content) {
    console.warn('[HiveAI:VLM] No content in VLM response');
    return empty;
  }

  const contentStr = rawResponse.choices[0].message.content;

  try {
    const parsed = JSON.parse(contentStr);

    return {
      topics: Array.isArray(parsed.topics) ? parsed.topics.map(normalizeString).filter(Boolean) : [],
      setting: typeof parsed.setting === 'string' ? normalizeString(parsed.setting) : '',
      objects: Array.isArray(parsed.objects) ? parsed.objects.map(normalizeString).filter(Boolean) : [],
      activities: Array.isArray(parsed.activities) ? parsed.activities.map(normalizeString).filter(Boolean) : [],
      mood: typeof parsed.mood === 'string' ? normalizeString(parsed.mood) : '',
      description: typeof parsed.description === 'string' ? parsed.description.trim() : ''
    };
  } catch (err) {
    console.error('[HiveAI:VLM] Failed to parse VLM content as JSON:', err.message);
    console.error('[HiveAI:VLM] Raw content:', contentStr.slice(0, 500));
    return empty;
  }
}

/**
 * Normalise a VLM classification response into the structured format
 * consumed by the classification pipeline.
 *
 * Produces the same top-level shape expected by formatForStorage, formatForGorse,
 * and formatForFunnelcake:
 *   - labels: Array<{ label, namespace, score }>
 *   - topCategories, topSettings, topObjects
 *   - description (new: useful for search / human review)
 *
 * VLM does not return confidence scores -- items are present or absent.
 * We assign a score of 1.0 to all returned items (the model only includes
 * items it is confident about).
 *
 * @param {Object} rawResponse - Raw Hive VLM chat completion response
 * @returns {Object} Normalised classification result
 */
export function normalizeVLMResponse(rawResponse) {
  const parsed = parseVLMContent(rawResponse);

  const result = {
    // Topics (equivalent to IAB categories)
    topics: parsed.topics,

    // Physical setting / environment
    setting: parsed.setting,

    // Notable objects detected
    objects: parsed.objects,

    // Activities happening in the video
    activities: parsed.activities,

    // Overall mood / tone
    mood: parsed.mood,

    // Human-readable description (valuable for search and review)
    description: parsed.description,

    // Pre-built top-N convenience lists
    topCategories: parsed.topics.map(topic => ({ category: topic, score: 1.0 })),
    topSettings: parsed.setting ? [{ setting: parsed.setting, score: 1.0 }] : [],
    topObjects: parsed.objects.map(obj => ({ object: obj, score: 1.0 })),

    // Token usage from the API (for cost tracking)
    usage: rawResponse?.usage || null,

    // Metadata
    classesDetected: parsed.topics.length + (parsed.setting ? 1 : 0) +
      parsed.objects.length + parsed.activities.length,
    extractedAt: new Date().toISOString()
  };

  console.log(
    `[HiveAI:VLM] Detected ${parsed.topics.length} topics, ` +
    `setting="${parsed.setting}", ${parsed.objects.length} objects, ` +
    `${parsed.activities.length} activities, mood="${parsed.mood}"`
  );

  return result;
}

/**
 * Convert a normalised VLM classification result into the label format
 * consumed by recommendation systems (funnelcake / gorse).
 *
 * Returns an array of label objects:
 *   { label: string, namespace: string, score: number }
 *
 * Namespaces:
 *   - "topic"    : Content topic/category
 *   - "setting"  : Physical scene/environment
 *   - "object"   : Detected object
 *   - "activity" : Activity happening in the video
 *   - "mood"     : Overall mood/tone
 *
 * @param {Object} classificationResult - Output of normalizeVLMResponse
 * @param {Object} options - Conversion options
 * @param {number} [options.maxLabels=50] - Maximum total labels to return
 * @returns {Array<Object>} Label array for recommendation systems
 */
export function toRecommendationLabels(classificationResult, options = {}) {
  if (!classificationResult) return [];

  const maxLabels = options.maxLabels ?? 50;
  const labels = [];

  // Topics (score 1.0 -- VLM only returns topics it detects)
  for (const topic of (classificationResult.topics || [])) {
    labels.push({ label: topic, namespace: 'topic', score: 1.0 });
  }

  // Setting
  if (classificationResult.setting) {
    labels.push({ label: classificationResult.setting, namespace: 'setting', score: 1.0 });
  }

  // Objects
  for (const obj of (classificationResult.objects || [])) {
    labels.push({ label: obj, namespace: 'object', score: 1.0 });
  }

  // Activities
  for (const activity of (classificationResult.activities || [])) {
    labels.push({ label: activity, namespace: 'activity', score: 1.0 });
  }

  // Mood
  if (classificationResult.mood) {
    labels.push({ label: classificationResult.mood, namespace: 'mood', score: 1.0 });
  }

  return labels.slice(0, maxLabels);
}
