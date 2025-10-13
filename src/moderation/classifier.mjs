// ABOUTME: Content severity classification logic
// ABOUTME: Determines action (SAFE/REVIEW/AGE_RESTRICTED/PERMANENT_BAN) based on moderation scores and content category

// Default thresholds (can be overridden by env vars)
const DEFAULT_NSFW_HIGH = 0.8;
const DEFAULT_NSFW_MEDIUM = 0.6;
const DEFAULT_VIOLENCE_HIGH = 0.8;
const DEFAULT_VIOLENCE_MEDIUM = 0.6;
const DEFAULT_AI_GENERATED_HIGH = 0.8;
const DEFAULT_AI_GENERATED_MEDIUM = 0.6;
const DEFAULT_GORE_HIGH = 0.8;
const DEFAULT_GORE_MEDIUM = 0.6;
const DEFAULT_OFFENSIVE_HIGH = 0.8;
const DEFAULT_OFFENSIVE_MEDIUM = 0.6;
const DEFAULT_WEAPON_HIGH = 0.8;
const DEFAULT_WEAPON_MEDIUM = 0.6;
const DEFAULT_DRUG_HIGH = 0.8;
const DEFAULT_DRUG_MEDIUM = 0.6;
const DEFAULT_SELF_HARM_HIGH = 0.7;
const DEFAULT_SELF_HARM_MEDIUM = 0.5;

// Categories that warrant permanent ban
const PERMANENT_BAN_CATEGORIES = ['self_harm', 'offensive'];

// Categories that warrant age restriction
const AGE_RESTRICTED_CATEGORIES = ['nudity', 'violence', 'gore', 'weapon', 'recreational_drug', 'alcohol', 'tobacco', 'gambling', 'destruction', 'ai_generated', 'deepfake'];

// Categories that are informational only (lower threshold for review)
const INFORMATIONAL_CATEGORIES = ['medical', 'money', 'military', 'text_profanity', 'qr_unsafe'];

/**
 * Classify moderation result into action categories
 * @param {Object} moderationData - Result from moderation service
 * @param {Object} moderationData.maxScores - All category scores
 * @param {Array} [moderationData.flaggedFrames] - Frames that exceeded thresholds
 * @param {Object} [env] - Environment variables with threshold config
 * @returns {Object} Classification result with action and severity
 */
export function classifyModerationResult(moderationData, env = {}) {
  const {
    maxScores = {},
    maxNudityScore = 0,
    maxViolenceScore = 0,
    maxAiGeneratedScore = 0,
    flaggedFrames = []
  } = moderationData;

  // Support both old and new format
  // Default values for all categories
  const defaultScores = {
    nudity: 0,
    violence: 0,
    ai_generated: 0,
    gore: 0,
    offensive: 0,
    weapon: 0,
    recreational_drug: 0,
    alcohol: 0,
    tobacco: 0,
    medical: 0,
    gambling: 0,
    money: 0,
    self_harm: 0,
    destruction: 0,
    military: 0,
    text_profanity: 0,
    qr_unsafe: 0
  };

  // Determine if using new format (has any maxScores) or old format
  const usingNewFormat = Object.keys(maxScores).length > 0;

  const scores = usingNewFormat ? {
    ...defaultScores,
    ...maxScores
  } : {
    ...defaultScores,
    nudity: maxNudityScore,
    violence: maxViolenceScore,
    ai_generated: maxAiGeneratedScore
  };

  // Load thresholds from env or use defaults
  const thresholds = {
    nudity: {
      high: parseFloat(env.NSFW_THRESHOLD_HIGH || DEFAULT_NSFW_HIGH),
      medium: parseFloat(env.NSFW_THRESHOLD_MEDIUM || DEFAULT_NSFW_MEDIUM)
    },
    violence: {
      high: parseFloat(env.VIOLENCE_THRESHOLD_HIGH || DEFAULT_VIOLENCE_HIGH),
      medium: parseFloat(env.VIOLENCE_THRESHOLD_MEDIUM || DEFAULT_VIOLENCE_MEDIUM)
    },
    ai_generated: {
      high: parseFloat(env.AI_GENERATED_THRESHOLD_HIGH || DEFAULT_AI_GENERATED_HIGH),
      medium: parseFloat(env.AI_GENERATED_THRESHOLD_MEDIUM || DEFAULT_AI_GENERATED_MEDIUM)
    },
    deepfake: {
      high: parseFloat(env.DEEPFAKE_THRESHOLD_HIGH || DEFAULT_AI_GENERATED_HIGH),
      medium: parseFloat(env.DEEPFAKE_THRESHOLD_MEDIUM || DEFAULT_AI_GENERATED_MEDIUM)
    },
    gore: {
      high: parseFloat(env.GORE_THRESHOLD_HIGH || DEFAULT_GORE_HIGH),
      medium: parseFloat(env.GORE_THRESHOLD_MEDIUM || DEFAULT_GORE_MEDIUM)
    },
    offensive: {
      high: parseFloat(env.OFFENSIVE_THRESHOLD_HIGH || DEFAULT_OFFENSIVE_HIGH),
      medium: parseFloat(env.OFFENSIVE_THRESHOLD_MEDIUM || DEFAULT_OFFENSIVE_MEDIUM)
    },
    weapon: {
      high: parseFloat(env.WEAPON_THRESHOLD_HIGH || DEFAULT_WEAPON_HIGH),
      medium: parseFloat(env.WEAPON_THRESHOLD_MEDIUM || DEFAULT_WEAPON_MEDIUM)
    },
    recreational_drug: {
      high: parseFloat(env.DRUG_THRESHOLD_HIGH || DEFAULT_DRUG_HIGH),
      medium: parseFloat(env.DRUG_THRESHOLD_MEDIUM || DEFAULT_DRUG_MEDIUM)
    },
    self_harm: {
      high: parseFloat(env.SELF_HARM_THRESHOLD_HIGH || DEFAULT_SELF_HARM_HIGH),
      medium: parseFloat(env.SELF_HARM_THRESHOLD_MEDIUM || DEFAULT_SELF_HARM_MEDIUM)
    },
    // Informational categories use lower thresholds (0.6 for review)
    alcohol: { high: 0.8, medium: 0.6 },
    tobacco: { high: 0.8, medium: 0.6 },
    gambling: { high: 0.8, medium: 0.6 },
    destruction: { high: 0.8, medium: 0.6 },
    military: { high: 0.8, medium: 0.6 },
    medical: { high: 0.8, medium: 0.6 },
    money: { high: 0.8, medium: 0.6 },
    text_profanity: { high: 0.8, medium: 0.6 },
    qr_unsafe: { high: 0.8, medium: 0.6 }
  };

  // Find primary concern (highest score)
  const primaryConcern = Object.entries(scores).reduce((a, b) =>
    scores[a[0]] >= scores[b[0]] ? a : b
  )[0];
  const primaryScore = scores[primaryConcern];

  // Determine action based on category and score
  let action, severity, reason, category;

  // Check for PERMANENT_BAN categories (self-harm, hate speech)
  if (scores.self_harm >= (thresholds.self_harm?.high || DEFAULT_SELF_HARM_HIGH)) {
    action = 'PERMANENT_BAN';
    severity = 'critical';
    category = 'self_harm';
    reason = 'Self-harm content detected - immediate removal required';
  }
  else if (scores.offensive >= (thresholds.offensive?.high || DEFAULT_OFFENSIVE_HIGH)) {
    action = 'PERMANENT_BAN';
    severity = 'critical';
    category = 'hate_speech';
    reason = 'Hate speech or offensive symbols detected - immediate removal required';
  }
  else if (scores.gore >= 0.95) {
    action = 'PERMANENT_BAN';
    severity = 'critical';
    category = 'extreme_gore';
    reason = 'Extreme gore content detected - immediate removal required';
  }
  // Check for AGE_RESTRICTED categories
  else if (AGE_RESTRICTED_CATEGORIES.some(cat => {
    const threshold = thresholds[cat];
    return threshold && scores[cat] >= threshold.high;
  })) {
    action = 'AGE_RESTRICTED';
    severity = 'high';
    category = primaryConcern;
    reason = `${getCategoryLabel(category)} content detected (score: ${primaryScore.toFixed(2)}) - requires age verification`;
  }
  // Check for REVIEW threshold
  else if (Object.keys(thresholds).some(cat => {
    const threshold = thresholds[cat];
    return threshold && scores[cat] >= threshold.medium && scores[cat] < threshold.high;
  })) {
    action = 'REVIEW';
    severity = 'medium';
    category = primaryConcern;
    reason = `Potential ${getCategoryLabel(category)} content detected (score: ${primaryScore.toFixed(2)}) - requires human review`;
  }
  else {
    action = 'SAFE';
    severity = 'low';
    category = null;
    reason = 'Content appears safe for all audiences';
  }

  return {
    action,
    severity,
    reason,
    primaryConcern,
    category,
    scores,
    flaggedFrames
  };
}

/**
 * Get human-readable label for category
 * @param {string} category - Category key
 * @returns {string} Human-readable label
 */
function getCategoryLabel(category) {
  const labels = {
    nudity: 'Adult',
    violence: 'Violent',
    ai_generated: 'AI-generated',
    gore: 'Gore',
    offensive: 'Hate speech',
    weapon: 'Weapon',
    recreational_drug: 'Drug',
    alcohol: 'Alcohol',
    tobacco: 'Tobacco',
    medical: 'Medical',
    gambling: 'Gambling',
    money: 'Money',
    self_harm: 'Self-harm',
    destruction: 'Destruction',
    military: 'Military',
    text_profanity: 'Profane text',
    qr_unsafe: 'Unsafe QR code'
  };
  return labels[category] || category;
}
