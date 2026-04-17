// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for queue message schema validation
// ABOUTME: Ensures messages from main service have correct structure

import { describe, it, expect } from 'vitest';
import { validateQueueMessage } from './queue-message.mjs';

describe('QueueMessage Schema', () => {
  it('should validate a complete queue message', () => {
    const message = {
      sha256: 'a'.repeat(64),
      uploadedBy: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
      uploadedAt: Date.now(),
      metadata: {
        fileSize: 1024000,
        contentType: 'video/mp4',
        duration: 6
      }
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(message);
  });

  it('should require sha256', () => {
    const message = {
      uploadedAt: Date.now()
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sha256');
  });

  it('should validate sha256 is 64 hex characters', () => {
    const message = {
      sha256: 'invalid',
      uploadedAt: Date.now()
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sha256');
  });

  // r2Key is not validated - the pipeline uses sha256 to construct CDN URLs
  // The Blossom protocol uses SHA-256 as the primary identifier

  it('should allow optional uploadedBy', () => {
    const message = {
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now()
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(true);
  });

  it('should validate uploadedBy is valid nostr pubkey if provided', () => {
    const message = {
      sha256: 'a'.repeat(64),
      uploadedBy: 'invalid-pubkey',
      uploadedAt: Date.now()
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('uploadedBy');
  });

  it('should allow missing metadata', () => {
    const message = {
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now()
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(true);
  });

  it('should allow optional Video Seal fields when null or valid', () => {
    const message = {
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now(),
      videoSealPayload: `01${'b'.repeat(62)}`,
      videoSealBitAccuracy: 0.92
    };

    const result = validateQueueMessage(message);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(message);

    const nullResult = validateQueueMessage({
      sha256: 'c'.repeat(64),
      uploadedAt: Date.now(),
      videoSealPayload: null,
      videoSealBitAccuracy: null
    });

    expect(nullResult.valid).toBe(true);
  });

  it('should reject invalid Video Seal payload values', () => {
    const result = validateQueueMessage({
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now(),
      videoSealPayload: 'not-hex'
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('videoSealPayload');
  });

  it('should reject invalid Video Seal bit accuracy values', () => {
    const result = validateQueueMessage({
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now(),
      videoSealBitAccuracy: 1.2
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('videoSealBitAccuracy');
  });
});
