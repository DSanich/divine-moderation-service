// ABOUTME: Text-based content classifier for VTT transcript analysis
// ABOUTME: Keyword/pattern matching for hate speech, threats, harassment, self-harm, profanity

// Weighted keyword lists — each match adds the weight to the category score
// Scores are normalized to 0-1 range based on total matches × weight / threshold

const PATTERNS = {
  hate_speech: {
    threshold: 3,
    terms: [
      // Racial slurs (weight 3 = single match is high signal)
      { pattern: /\bn[i1]gg[ae3]r?s?\b/gi, weight: 3 },
      { pattern: /\bk[i1]ke[s]?\b/gi, weight: 3 },
      { pattern: /\bsp[i1]c[sk]?\b/gi, weight: 2 },
      { pattern: /\bch[i1]nk[s]?\b/gi, weight: 2 },
      { pattern: /\bwetback[s]?\b/gi, weight: 3 },
      { pattern: /\bcoon[s]?\b/gi, weight: 2 },
      // Anti-LGBTQ
      { pattern: /\bf[a4]gg?[o0]t[s]?\b/gi, weight: 2 },
      { pattern: /\btr[a4]nn[yi]e?[s]?\b/gi, weight: 2 },
      { pattern: /\bdyke[s]?\b/gi, weight: 1.5 },
      // Religious
      { pattern: /\btowel\s*head[s]?\b/gi, weight: 2 },
      { pattern: /\bsand\s*n[i1]gg[ae]r\b/gi, weight: 3 },
      // White supremacy
      { pattern: /\bwhite\s*(power|supremac|nation)/gi, weight: 2 },
      { pattern: /\bheil\s*hitler\b/gi, weight: 3 },
      { pattern: /\b14\s*88\b/g, weight: 2 },
      { pattern: /\bgas\s*the\s*jews\b/gi, weight: 3 },
      { pattern: /\brace\s*war\b/gi, weight: 2 },
    ]
  },

  threats: {
    threshold: 3,
    terms: [
      { pattern: /\b(i'?ll|i'?m\s*gonna?|going\s*to)\s*(kill|murder|shoot|stab|strangle)\b/gi, weight: 3 },
      { pattern: /\bkill\s*(you|them|all|every)/gi, weight: 3 },
      { pattern: /\bschool\s*shoot/gi, weight: 3 },
      { pattern: /\bbomb\s*(threat|this|that|the)/gi, weight: 3 },
      { pattern: /\bshoot\s*up\b/gi, weight: 2 },
      { pattern: /\b(rape|assault)\s*(you|her|him|them)/gi, weight: 3 },
      { pattern: /\byou('re|\s*are)\s*(dead|gonna\s*die)/gi, weight: 2 },
      { pattern: /\bswat\s*(you|them|his|her)/gi, weight: 2 },
      { pattern: /\bdox+\s*(you|them|his|her)/gi, weight: 2 },
    ]
  },

  harassment: {
    threshold: 4,
    terms: [
      { pattern: /\bkill\s*yourself\b/gi, weight: 3 },
      { pattern: /\bkys\b/gi, weight: 2 },
      { pattern: /\bno\s*one\s*loves\s*you\b/gi, weight: 1.5 },
      { pattern: /\byou\s*should\s*(die|be\s*dead)\b/gi, weight: 3 },
      { pattern: /\bworthless\s*(piece|bitch|whore|cunt)\b/gi, weight: 2 },
      { pattern: /\bgo\s*(die|hang\s*yourself|jump)\b/gi, weight: 3 },
      { pattern: /\bslut\b/gi, weight: 1 },
      { pattern: /\bwhore\b/gi, weight: 1 },
      { pattern: /\bcunt\b/gi, weight: 1.5 },
    ]
  },

  self_harm: {
    threshold: 3,
    terms: [
      { pattern: /\b(cut|cutting)\s*(myself|my\s*(wrist|arm))/gi, weight: 3 },
      { pattern: /\bsuicid(e|al)\b/gi, weight: 2 },
      { pattern: /\bwant\s*to\s*die\b/gi, weight: 3 },
      { pattern: /\bend\s*(it|my\s*life)\b/gi, weight: 2 },
      { pattern: /\bself[- ]?harm/gi, weight: 2 },
      { pattern: /\bhang\s*myself\b/gi, weight: 3 },
      { pattern: /\boverdose\b/gi, weight: 1.5 },
      { pattern: /\bjump\s*(off|from)\s*(a|the)\s*(bridge|building|roof)/gi, weight: 3 },
    ]
  },

  grooming: {
    threshold: 4,
    terms: [
      { pattern: /\bdon'?t\s*tell\s*(anyone|your\s*(mom|dad|parents))/gi, weight: 3 },
      { pattern: /\bour\s*(little)?\s*secret\b/gi, weight: 2 },
      { pattern: /\bhow\s*old\s*are\s*you\b/gi, weight: 1 },
      { pattern: /\bsend\s*(me\s*)?(pics|nudes|photos)/gi, weight: 2 },
      { pattern: /\bshow\s*me\s*(your|ur)\s*(body|privates)/gi, weight: 3 },
      { pattern: /\bage\s*is\s*just\s*a\s*number\b/gi, weight: 3 },
      { pattern: /\bmature\s*for\s*(your|ur)\s*age\b/gi, weight: 2 },
    ]
  },

  profanity: {
    threshold: 6,
    terms: [
      { pattern: /\bfuck(ing|ed|er|s)?\b/gi, weight: 1 },
      { pattern: /\bshit(ty|s|ting)?\b/gi, weight: 0.5 },
      { pattern: /\bbitch(es|ing)?\b/gi, weight: 1 },
      { pattern: /\bass\s*hole[s]?\b/gi, weight: 0.5 },
      { pattern: /\bdick(head|s)?\b/gi, weight: 0.5 },
      { pattern: /\bcock\s*suck/gi, weight: 1 },
      { pattern: /\bmotherfuck/gi, weight: 1 },
    ]
  }
};

/**
 * Classify text content for harmful categories.
 * Returns scores normalized to 0-1 range.
 *
 * @param {string} text - Plain text to classify
 * @returns {{hate_speech: number, threats: number, harassment: number, self_harm: number, grooming: number, profanity: number}}
 */
export function classifyText(text) {
  if (!text || text.trim().length === 0) {
    return { hate_speech: 0, threats: 0, harassment: 0, self_harm: 0, grooming: 0, profanity: 0 };
  }

  const scores = {};

  for (const [category, config] of Object.entries(PATTERNS)) {
    let totalWeight = 0;

    for (const { pattern, weight } of config.terms) {
      const matches = text.match(pattern);
      if (matches) {
        totalWeight += matches.length * weight;
      }
    }

    // Normalize: score of 1.0 when totalWeight >= threshold
    scores[category] = Math.min(1.0, totalWeight / config.threshold);
  }

  return scores;
}

/**
 * Parse VTT content and extract plain text (strip headers, timestamps, cue IDs).
 *
 * @param {string} vttContent - Raw VTT file content
 * @returns {string} Plain text from all cues
 */
export function parseVttText(vttContent) {
  const lines = vttContent.split('\n');
  const textLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, WEBVTT header, timestamp lines, cue IDs (numbers), NOTE blocks
    if (
      !trimmed ||
      trimmed === 'WEBVTT' ||
      trimmed.startsWith('WEBVTT ') ||
      trimmed.includes('-->') ||
      /^\d+$/.test(trimmed) ||
      trimmed.startsWith('NOTE')
    ) {
      continue;
    }
    // Strip VTT formatting tags like <v Speaker>, <b>, <i>, etc.
    const clean = trimmed.replace(/<[^>]+>/g, '');
    if (clean) {
      textLines.push(clean);
    }
  }

  return textLines.join(' ');
}
