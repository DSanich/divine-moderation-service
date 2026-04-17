// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Interprets upstream Video Seal watermark payloads into moderation signals
// ABOUTME: Maps known payload prefixes to trusted provenance metadata and flags unknown prefixes for research

const SIGNAL = 'videoseal';
const MINIMUM_BIT_ACCURACY = 0.85;

const KNOWN_PAYLOAD_PREFIXES = {
  0x01: {
    source: 'divine',
    isAI: false,
    verified: true
  },
  // TODO: Populate Meta prefix entries once Facebook/Instagram production payload
  // schemas are validated empirically from real extracted payloads.
};

function buildUndetectedSignal() {
  return {
    signal: SIGNAL,
    detected: false,
    confidence: 0
  };
}

export function interpretVideoSealPayload(payload, bitAccuracy) {
  if (
    typeof payload !== 'string'
    || payload.length === 0
    || typeof bitAccuracy !== 'number'
    || !Number.isFinite(bitAccuracy)
    || bitAccuracy < MINIMUM_BIT_ACCURACY
  ) {
    return buildUndetectedSignal();
  }

  const prefix = Number.parseInt(payload.slice(0, 2), 16);
  const knownPrefix = KNOWN_PAYLOAD_PREFIXES[prefix];

  if (!knownPrefix) {
    // Unknown prefixes are research signals only; downweight until calibrated
    // against production payloads from a known extractor/model pair.
    return {
      signal: SIGNAL,
      detected: true,
      source: 'unknown',
      isAI: null,
      action: 'flag_for_research',
      payload,
      confidence: bitAccuracy * 0.5
    };
  }

  return {
    signal: SIGNAL,
    detected: true,
    source: knownPrefix.source,
    isAI: knownPrefix.isAI,
    payload,
    confidence: bitAccuracy * (knownPrefix.verified ? 1 : 0.5)
  };
}
