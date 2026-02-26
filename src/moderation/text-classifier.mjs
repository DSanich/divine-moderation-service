// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Text-based content classifier for VTT transcript analysis
// ABOUTME: Uses keyword/pattern matching with weighted scoring to detect harmful text content

// Each entry: { pattern: RegExp, weight: number }
// Scores are summed per match and capped at 1.0

const HATE_SPEECH_PATTERNS = [
  // Racial/ethnic slurs
  { pattern: /\bn[i1]gg[ae3]r(s)?\b/gi, weight: 0.7 },
  { pattern: /\bsp[i1]c(s)?\b/gi, weight: 0.6 },
  { pattern: /\bk[i1]ke(s)?\b/gi, weight: 0.6 },
  { pattern: /\bch[i1]nk(s)?\b/gi, weight: 0.6 },
  { pattern: /\bw[e3]tb[a4]ck(s)?\b/gi, weight: 0.6 },
  { pattern: /\bgor(e)?-amer[i1]can\b/gi, weight: 0.5 },
  { pattern: /\bs[a4]nd\s*n[i1]gg[ae3]r(s)?\b/gi, weight: 0.7 },
  { pattern: /\bcoon(s)?\b/gi, weight: 0.5 },
  { pattern: /\bgook(s)?\b/gi, weight: 0.5 },
  { pattern: /\bzip(per)?head(s)?\b/gi, weight: 0.5 },
  { pattern: /\bbeaner(s)?\b/gi, weight: 0.5 },
  // Homophobic/transphobic slurs
  { pattern: /\bf[a4]gg?(ot)?(s)?\b/gi, weight: 0.5 },
  { pattern: /\bd[i1]ke(s)?\b/gi, weight: 0.4 },
  { pattern: /\btr[a4]nny\b/gi, weight: 0.5 },
  { pattern: /\bsh[e3]male(s)?\b/gi, weight: 0.4 },
  // Religious/ethnic hate phrases
  { pattern: /\bheil\s+hitler\b/gi, weight: 0.9 },
  { pattern: /\b(white|black)\s+power\b/gi, weight: 0.6 },
  { pattern: /\b14\s*words?\b/gi, weight: 0.5 },
  { pattern: /\b(death|die|kill|exterminate)\s+to\s+(jews?|muslims?|christians?|blacks?|gays?|whites?)\b/gi, weight: 0.9 },
  { pattern: /\b(all|these?)\s+(blacks?|jews?|muslims?|gays?|immigrants?)\s+(should|must|need\s+to|deserve\s+to)\s+(die|be\s+killed|suffer)\b/gi, weight: 0.9 },
  { pattern: /\b(jew|muslim|black|gay)\s+(scum|vermin|filth|trash|garbage)\b/gi, weight: 0.7 },
  { pattern: /\b(gas\s+the|hang\s+the|lynch\s+the)\s+(jews?|blacks?|gays?)\b/gi, weight: 0.9 },
];

const HARASSMENT_PATTERNS = [
  { pattern: /\bgo\s+kill\s+your(self)?\b/gi, weight: 0.7 },
  { pattern: /\bkys\b/gi, weight: 0.6 },
  { pattern: /\byou\s+(should|deserve\s+to|need\s+to)\s+(die|be\s+killed|suffer|rot)\b/gi, weight: 0.6 },
  { pattern: /\byou('re|\s+are)\s+(worthless|pathetic|disgusting|subhuman|trash|garbage|a\s+waste)\b/gi, weight: 0.4 },
  { pattern: /\b(nobody|no\s+one)\s+(likes?|wants?|cares?\s+about|loves?)\s+you\b/gi, weight: 0.3 },
  { pattern: /\bhope\s+(you\s+)?(die|get\s+(cancer|aids|killed|hurt|raped))\b/gi, weight: 0.6 },
  { pattern: /\bdox(x?ing|x?ed|x)?\b/gi, weight: 0.4 },
  { pattern: /\bswatt?ing\b/gi, weight: 0.5 },
  { pattern: /\b(i('ll|\s+will))\s+(find|come\s+for|come\s+after)\s+you\b/gi, weight: 0.5 },
  { pattern: /\byou\s+better\s+(watch\s+out|watch\s+your\s+back|be\s+afraid)\b/gi, weight: 0.4 },
  { pattern: /\b(your\s+(family|kids?|children|wife|husband|girlfriend|boyfriend))\s+(will|are\s+going\s+to)\s+(die|suffer|pay)\b/gi, weight: 0.7 },
];

const THREAT_PATTERNS = [
  { pattern: /\bi('ll|\s+will|\s+am\s+going\s+to)\s+(kill|murder|end|destroy|hurt|harm|attack|shoot|stab)\s+(you|him|her|them|your)\b/gi, weight: 0.7 },
  { pattern: /\byou('re|\s+are)\s+(going\s+to|gonna)\s+(die|be\s+killed|regret\s+this|pay\s+for\s+this)\b/gi, weight: 0.6 },
  { pattern: /\b(i('m|\s+am))\s+(coming\s+for\s+you|armed|on\s+my\s+way\s+to)\b/gi, weight: 0.6 },
  { pattern: /\byou\s+won't\s+(live|survive|make\s+it|see\s+tomorrow)\b/gi, weight: 0.6 },
  { pattern: /\b(shoot|bomb|blow\s+up|attack)\s+(the|this|that|your)\s+(school|church|mosque|synagogue|building|office)\b/gi, weight: 0.9 },
  { pattern: /\b(send(ing)?|mail(ing)?)\s+(a\s+)?(bomb|explosive|poison|anthrax)\b/gi, weight: 0.8 },
  { pattern: /\b(mass\s+)?(shooting|stabbing|bombing|attack)\s+(plan(ned)?|at)\b/gi, weight: 0.7 },
  { pattern: /\b(i|we)\s+(have\s+a\s+)?(\w+\s+)?(gun|knife|weapon|explosiv)\b/gi, weight: 0.4 },
  { pattern: /\byour\s+(address|location|school|workplace)\s+is\b/gi, weight: 0.5 },
];

const SELF_HARM_PATTERNS = [
  { pattern: /\b(kill|hurt|harm|end|cut)\s+(my)?self\b/gi, weight: 0.6 },
  { pattern: /\bsuicid(e|al|e\s+method|e\s+note)\b/gi, weight: 0.5 },
  { pattern: /\b(want|planning|going)\s+to\s+(die|end\s+it(\s+all)?|end\s+my\s+(life|pain)|not\s+be\s+here)\b/gi, weight: 0.5 },
  { pattern: /\b(no|nothing)\s+to\s+live\s+for\b/gi, weight: 0.5 },
  { pattern: /\b(overdose|od('?ing|'?ed)?)\s+(on|with)\b/gi, weight: 0.5 },
  { pattern: /\bself[\s-]harm(ing)?\b/gi, weight: 0.6 },
  { pattern: /\b(slit(ting)?|cut(ting)?)\s+(my\s+)?(wrists?|arms?)\b/gi, weight: 0.7 },
  { pattern: /\bhow\s+to\s+(kill|hang|shoot|drown)\s+(my)?self\b/gi, weight: 0.8 },
  { pattern: /\b(jump(ing)?\s+off|hang(ing)?\s+(my)?self)\b/gi, weight: 0.6 },
  { pattern: /\b(i\s+don't\s+want\s+to\s+(be\s+)?alive|life\s+is(n't|\s+not)\s+worth\s+(it|living))\b/gi, weight: 0.4 },
  { pattern: /\b(method|ways?)\s+(to|of)\s+(commit\s+)?suicide\b/gi, weight: 0.7 },
];

const PROFANITY_PATTERNS = [
  { pattern: /\bf+u+c+k+(ing|er|s|ed|face|head|wit)?\b/gi, weight: 0.3 },
  { pattern: /\bs+h+[i1]+t+(ty|hole|bag|face|head)?\b/gi, weight: 0.2 },
  { pattern: /\ba+s+s+(hole|hat|wipe|face|clown)?\b/gi, weight: 0.2 },
  { pattern: /\bb[i1]tch(es|ing|y)?\b/gi, weight: 0.25 },
  { pattern: /\bc[u*]nt(s)?\b/gi, weight: 0.4 },
  { pattern: /\bcock(sucker|s)?\b/gi, weight: 0.3 },
  { pattern: /\bdick(head|s)?\b/gi, weight: 0.2 },
  { pattern: /\bbastard(s)?\b/gi, weight: 0.2 },
  { pattern: /\bwh[o0]re(s)?\b/gi, weight: 0.3 },
  { pattern: /\bslut(s|ty)?\b/gi, weight: 0.3 },
  { pattern: /\bmotherfuck(er|ing)?\b/gi, weight: 0.4 },
  { pattern: /\bdamn(it)?\b/gi, weight: 0.1 },
  { pattern: /\bpiss(ed|ing)?\b/gi, weight: 0.1 },
  { pattern: /\bcrap(py)?\b/gi, weight: 0.05 },
  { pattern: /\bjerk(off)?\b/gi, weight: 0.1 },
];

/**
 * Score text against a set of patterns
 * @param {string} text - Text to score
 * @param {Array} patterns - Array of {pattern, weight} objects
 * @returns {number} Score between 0 and 1
 */
function scorePatterns(text, patterns) {
  let score = 0;
  for (const { pattern, weight } of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      score += matches.length * weight;
    }
  }
  return Math.min(1.0, score);
}

/**
 * Classify text for harmful content using pattern matching
 * @param {string} text - Plain text to analyze
 * @returns {{hate_speech: number, harassment: number, threats: number, self_harm: number, profanity: number}}
 */
export function classifyText(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { hate_speech: 0, harassment: 0, threats: 0, self_harm: 0, profanity: 0 };
  }

  return {
    hate_speech: scorePatterns(text, HATE_SPEECH_PATTERNS),
    harassment: scorePatterns(text, HARASSMENT_PATTERNS),
    threats: scorePatterns(text, THREAT_PATTERNS),
    self_harm: scorePatterns(text, SELF_HARM_PATTERNS),
    profanity: scorePatterns(text, PROFANITY_PATTERNS),
  };
}

/**
 * Parse VTT content and extract plain text
 * @param {string} vttContent - Raw VTT file content
 * @returns {string} Extracted plain text
 */
export function parseVttText(vttContent) {
  if (!vttContent || typeof vttContent !== 'string') return '';

  const lines = vttContent.split(/\r?\n/);
  const textLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip WEBVTT header and NOTE/STYLE/REGION blocks
    if (trimmed.startsWith('WEBVTT') || trimmed.startsWith('NOTE') || trimmed.startsWith('STYLE') || trimmed.startsWith('REGION')) continue;
    // Skip timestamp lines (contain -->)
    if (trimmed.includes('-->')) continue;
    // Skip pure numeric or alphanumeric cue identifiers (e.g. "1", "cue-1")
    if (/^[\w-]+$/.test(trimmed) && !trimmed.includes(' ')) continue;
    // Skip empty lines
    if (!trimmed) continue;
    // Strip inline VTT tags like <c.colorwhite>, <00:00:01.000>, </c>
    const stripped = trimmed.replace(/<[^>]+>/g, '').trim();
    if (stripped) textLines.push(stripped);
  }

  return textLines.join(' ');
}
