// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Policy helpers for deciding when paid AI-generated detection should run
// ABOUTME: Keeps ProofMode cost gating consistent across queue and pipeline paths

export function shouldForceAIDetection(metadata) {
  return metadata?.forceAIDetection === true || metadata?.force_ai_detection === true;
}

export function proofModeSkipsAIDetection(c2pa, metadata) {
  return c2pa?.state === 'valid_proofmode' && !shouldForceAIDetection(metadata);
}

export function getAIDetectionPolicyDecision({ c2pa, metadata, originalVine = false } = {}) {
  const aiDetectionForced = shouldForceAIDetection(metadata);

  if (aiDetectionForced) {
    return {
      aiDetectionAllowed: true,
      aiDetectionForced: true,
      policyReason: 'report_forced_ai_detection',
    };
  }

  if (c2pa?.state === 'valid_ai_signed') {
    return {
      aiDetectionAllowed: false,
      aiDetectionForced: false,
      policyReason: 'valid_ai_signed_skip',
    };
  }

  if (c2pa?.state === 'valid_proofmode') {
    return {
      aiDetectionAllowed: false,
      aiDetectionForced: false,
      policyReason: 'valid_proofmode_skip',
    };
  }

  if (originalVine) {
    return {
      aiDetectionAllowed: false,
      aiDetectionForced: false,
      policyReason: 'original_vine_skip',
    };
  }

  const c2paState = c2pa?.state || 'unchecked';
  return {
    aiDetectionAllowed: true,
    aiDetectionForced: false,
    policyReason: c2paState === 'absent' || c2paState === 'unchecked'
      ? 'no_proof_ai_detection'
      : 'provenance_present_ai_detection',
  };
}
