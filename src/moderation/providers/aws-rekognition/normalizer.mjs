// ABOUTME: Normalizes AWS Rekognition responses to standard format
// ABOUTME: Maps AWS categories and confidence scores to Divine's schema

/**
 * Normalize AWS Rekognition response to standard format
 * @param {Object} awsResult - Raw AWS Rekognition result
 * @returns {Object} Normalized moderation result
 */
export function normalizeRekognitionResponse(awsResult) {
  const labels = awsResult.ModerationLabels || [];

  // Initialize scores
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
    aiGenerated: 0, // AWS doesn't detect this
    deepfake: 0     // AWS doesn't detect this
  };

  const details = {
    nudity: {},
    violence: {},
    gore: {},
    offensive: {},
    weapons: {},
    drugs: {},
    alcohol: {},
    tobacco: {},
    gambling: {},
    selfHarm: {}
  };

  const flaggedFrames = [];
  const frameMap = new Map(); // timestamp -> frame data

  // Process each moderation label
  for (const label of labels) {
    const timestamp = label.Timestamp / 1000; // Convert ms to seconds
    const category = label.ModerationLabel.ParentName || label.ModerationLabel.Name;
    const subcategory = label.ModerationLabel.Name;
    const confidence = label.ModerationLabel.Confidence / 100; // Convert to 0-1

    // Map AWS categories to our standard categories
    const mappedCategory = mapAWSCategory(category);
    if (!mappedCategory) continue;

    // Update max scores
    scores[mappedCategory] = Math.max(scores[mappedCategory], confidence);

    // Update detailed subcategories
    if (details[mappedCategory]) {
      const subcategoryKey = toCamelCase(subcategory);
      details[mappedCategory][subcategoryKey] = Math.max(
        details[mappedCategory][subcategoryKey] || 0,
        confidence
      );
    }

    // Track frames
    if (!frameMap.has(timestamp)) {
      frameMap.set(timestamp, {
        position: timestamp,
        scores: {},
        details: {},
        labels: []
      });
    }

    const frame = frameMap.get(timestamp);
    frame.scores[mappedCategory] = Math.max(frame.scores[mappedCategory] || 0, confidence);
    frame.labels.push({
      category: mappedCategory,
      subcategory,
      confidence
    });
  }

  // Convert frame map to flagged frames array
  for (const frame of frameMap.values()) {
    // Flag if any score >= 0.7
    const hasHighScore = Object.values(frame.scores).some(score => score >= 0.7);

    if (hasHighScore) {
      // Find primary concern
      const primaryEntry = Object.entries(frame.scores).reduce((a, b) =>
        a[1] >= b[1] ? a : b
      );

      flaggedFrames.push({
        ...frame,
        primaryConcern: primaryEntry[0],
        primaryScore: primaryEntry[1]
      });
    }
  }

  // Sort flagged frames by timestamp
  flaggedFrames.sort((a, b) => a.position - b.position);

  return {
    scores,
    details,
    flaggedFrames
  };
}

/**
 * Map AWS Rekognition categories to our standard categories
 * @param {string} awsCategory - AWS category name
 * @returns {string|null} Mapped category or null if unknown
 */
function mapAWSCategory(awsCategory) {
  const categoryMap = {
    // Nudity categories
    'Explicit Nudity': 'nudity',
    'Nudity': 'nudity',
    'Suggestive': 'nudity',

    // Violence categories
    'Violence': 'violence',
    'Graphic Violence Or Gore': 'gore',
    'Physical Violence': 'violence',

    // Weapons
    'Weapons': 'weapons',
    'Weapon Violence': 'weapons',

    // Drugs
    'Drugs': 'drugs',
    'Drug Products': 'drugs',
    'Drug Use': 'drugs',
    'Pills': 'drugs',
    'Drug Paraphernalia': 'drugs',

    // Alcohol
    'Alcohol': 'alcohol',
    'Alcoholic Beverages': 'alcohol',
    'Drinking': 'alcohol',

    // Tobacco
    'Tobacco': 'tobacco',
    'Tobacco Products': 'tobacco',
    'Smoking': 'tobacco',

    // Gambling
    'Gambling': 'gambling',

    // Hate & offensive
    'Hate Symbols': 'offensive',
    'Nazi Party': 'offensive',
    'White Supremacy': 'offensive',
    'Extremist': 'offensive',

    // Self-harm
    'Self Injury': 'selfHarm',
    'Emaciation': 'selfHarm'
  };

  return categoryMap[awsCategory] || null;
}

/**
 * Convert string to camelCase
 * @param {string} str - Input string
 * @returns {string} camelCase version
 */
function toCamelCase(str) {
  return str
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) =>
      index === 0 ? letter.toLowerCase() : letter.toUpperCase()
    )
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '');
}
