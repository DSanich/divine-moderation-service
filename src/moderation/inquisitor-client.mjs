// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Divine-inquisitor C2PA/ProofMode verification client
// ABOUTME: Calls inquisitor.divine.video /verify in URL mode and normalizes response into a tri-state policy signal

const DEFAULT_MIME_TYPE = 'video/mp4';

const AI_TOOL_PATTERNS = [
  'adobe firefly',
  'dall·e',
  'dall-e',
  'dalle',
  'midjourney',
  'stable diffusion',
  'sora',
  'runway',
  'ideogram',
];

export function isAiToolClaimGenerator(claimGenerator) {
  if (!claimGenerator || typeof claimGenerator !== 'string') return false;
  const lower = claimGenerator.toLowerCase();
  return AI_TOOL_PATTERNS.some((pattern) => lower.includes(pattern));
}

function deriveState({ hasC2pa, valid, isProofmode, claimGenerator }) {
  if (!hasC2pa) return 'absent';
  if (!valid) return 'invalid';
  if (isProofmode) return 'valid_proofmode';
  if (isAiToolClaimGenerator(claimGenerator)) return 'valid_ai_signed';
  return 'valid_c2pa';
}

function uncheckedResult(error) {
  return {
    state: 'unchecked',
    hasC2pa: false,
    valid: false,
    isProofmode: false,
    validationState: 'unknown',
    claimGenerator: null,
    captureDevice: null,
    captureTime: null,
    signer: null,
    assertions: [],
    verifiedAt: null,
    checkedAt: new Date().toISOString(),
    error,
  };
}

export async function verifyC2pa({ url, mimeType }, env, { fetchFn = fetch } = {}) {
  if (!env?.INQUISITOR_BASE_URL) {
    return uncheckedResult('INQUISITOR_BASE_URL not configured');
  }

  const endpoint = `${env.INQUISITOR_BASE_URL.replace(/\/$/, '')}/verify`;
  const body = JSON.stringify({ url, mime_type: mimeType || DEFAULT_MIME_TYPE });

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      return uncheckedResult(`inquisitor responded ${response.status}`);
    }

    const data = await response.json();
    const hasC2pa = Boolean(data.has_c2pa);
    const valid = Boolean(data.valid);
    const isProofmode = Boolean(data.is_proofmode);
    const claimGenerator = data.claim_generator ?? null;

    return {
      state: deriveState({ hasC2pa, valid, isProofmode, claimGenerator }),
      hasC2pa,
      valid,
      isProofmode,
      validationState: data.validation_state ?? 'unknown',
      claimGenerator,
      captureDevice: data.capture_device ?? null,
      captureTime: data.capture_time ?? null,
      signer: data.signer ?? null,
      assertions: Array.isArray(data.assertions) ? data.assertions : [],
      verifiedAt: data.verified_at ?? null,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    return uncheckedResult(err?.message || String(err));
  }
}
