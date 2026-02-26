// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Hive.AI VLM (Vision Language Model) API client for video classification
// ABOUTME: Calls the Hive V3 chat/completions endpoint to classify video content

const HIVE_VLM_ENDPOINT = 'https://api.thehive.ai/api/v3/chat/completions';

const DEFAULT_VLM_PROMPT =
  'Classify this short video for a recommendation system. Identify the main content topics ' +
  '(e.g., music, comedy, dance, sports, food, animals, fashion, art, education, gaming, nature, ' +
  'technology, travel, fitness, news, beauty, DIY, automotive, pets, family), the physical setting, ' +
  'notable objects, activities happening, the overall mood, and write a brief description. ' +
  'Be specific and concise.';

/**
 * JSON schema sent to the VLM for structured output.
 * Ensures the model returns a predictable shape.
 */
const VLM_RESPONSE_SCHEMA = {
  name: 'video_classification',
  schema: {
    type: 'object',
    properties: {
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: 'Top content topics/categories'
      },
      setting: {
        type: 'string',
        description: 'Physical setting/environment'
      },
      objects: {
        type: 'array',
        items: { type: 'string' },
        description: 'Notable objects visible'
      },
      activities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Activities happening in the video'
      },
      mood: {
        type: 'string',
        description: 'Overall mood/tone'
      },
      description: {
        type: 'string',
        description: 'Brief 1-2 sentence description of the video'
      }
    },
    required: ['topics', 'setting', 'objects', 'activities', 'mood', 'description'],
    additionalProperties: false
  }
};

/**
 * Call the Hive VLM (V3) chat/completions endpoint to classify a video.
 *
 * The endpoint is OpenAI-compatible with structured JSON output via
 * `response_format.json_schema`.  A single prompt analyses all sampled
 * frames together (prompt_scope: "once") and returns one JSON object.
 *
 * @param {string} videoUrl - Public URL to video
 * @param {string} apiKey  - Hive VLM API key (V3)
 * @param {Object} options
 * @param {Function} [options.fetchFn] - Custom fetch (for testing)
 * @param {string}   [options.prompt]  - Override the default classification prompt
 * @param {number}   [options.maxTokens=512] - Max tokens for the response
 * @param {number}   [options.fps=1] - Frame sampling rate (frames per second)
 * @returns {Promise<Object>} Raw Hive VLM chat completion response
 */
export async function callVLMClassificationAPI(videoUrl, apiKey, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const prompt = options.prompt || DEFAULT_VLM_PROMPT;
  const maxTokens = options.maxTokens || 512;
  const fps = options.fps || 1;

  const body = {
    model: 'hive/vision-language-model',
    max_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: VLM_RESPONSE_SCHEMA
    },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'media_url',
          media_url: {
            url: videoUrl,
            sampling: { strategy: 'fps', fps },
            prompt_scope: 'once'
          }
        },
        {
          type: 'text',
          text: prompt
        }
      ]
    }]
  };

  const response = await fetchFn(HIVE_VLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Hive VLM API error: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Classify a video using the Hive VLM (Vision Language Model).
 *
 * Returns structured topics, setting, objects, activities, mood,
 * and a description -- all in a single JSON response.
 *
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} env - Environment with HIVE_VLM_API_KEY (and optional HIVE_VLM_PROMPT)
 * @param {Object} options - Options (fetchFn for testing)
 * @returns {Promise<Object>} Raw Hive VLM chat completion response
 */
export async function classifyWithHiveVLM(videoUrl, env, options = {}) {
  if (!env.HIVE_VLM_API_KEY) {
    throw new Error('HIVE_VLM_API_KEY not configured');
  }

  const prompt = env.HIVE_VLM_PROMPT || undefined;

  console.log('[HiveAI:VLM] Submitting for VLM classification:', videoUrl);
  const result = await callVLMClassificationAPI(videoUrl, env.HIVE_VLM_API_KEY, {
    ...options,
    prompt
  });
  console.log('[HiveAI:VLM] Received VLM classification response');
  return result;
}
