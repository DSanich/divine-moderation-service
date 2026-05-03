// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for paid AI-detection policy gates
// ABOUTME: Verifies ProofMode skips AI detection unless an AI report forces it

import { describe, expect, it } from 'vitest';
import { proofModeSkipsAIDetection, shouldForceAIDetection } from './ai-detection-policy.mjs';

describe('AI detection policy', () => {
  it('forces AI detection for camelCase and snake_case queue metadata flags', () => {
    expect(shouldForceAIDetection({ forceAIDetection: true })).toBe(true);
    expect(shouldForceAIDetection({ force_ai_detection: true })).toBe(true);
  });

  it('does not force AI detection for absent or false metadata flags', () => {
    expect(shouldForceAIDetection(null)).toBe(false);
    expect(shouldForceAIDetection({})).toBe(false);
    expect(shouldForceAIDetection({ forceAIDetection: false })).toBe(false);
  });

  it('skips AI detection for valid ProofMode unless forced by a report', () => {
    expect(proofModeSkipsAIDetection({ state: 'valid_proofmode' }, {})).toBe(true);
    expect(proofModeSkipsAIDetection({ state: 'valid_proofmode' }, { forceAIDetection: true })).toBe(false);
    expect(proofModeSkipsAIDetection({ state: 'absent' }, {})).toBe(false);
  });
});
