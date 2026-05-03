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
