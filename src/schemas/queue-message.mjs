// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Queue message schema for video moderation requests
// ABOUTME: Validates incoming messages from the main divine video service

/**
 * Queue message structure expected from main service
 * @typedef {Object} QueueMessage
 * @property {string} sha256 - SHA256 hash of the video (64 hex chars)
 * @property {string} [uploadedBy] - Nostr pubkey of uploader (64 hex chars)
 * @property {number} uploadedAt - Unix timestamp in milliseconds
 * @property {Object} [metadata] - Optional metadata about the video
 * @property {number} [metadata.fileSize] - File size in bytes
 * @property {string} [metadata.contentType] - MIME type
 * @property {number} [metadata.duration] - Duration in seconds
 * @property {string | null} [videoSealPayload] - Upstream Video Seal payload as 64 hex chars
 * @property {number | null} [videoSealBitAccuracy] - Upstream Video Seal bit accuracy from 0 to 1
 */

const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

/**
 * Validates a queue message
 * @param {any} message - Message to validate
 * @returns {{valid: true, data: QueueMessage} | {valid: false, error: string}}
 */
export function validateQueueMessage(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'Message must be an object' };
  }

  // Validate sha256 (only required field - Blossom protocol uses SHA-256 as primary key)
  if (!message.sha256 || typeof message.sha256 !== 'string') {
    return { valid: false, error: 'sha256 is required and must be a string' };
  }
  if (!HEX_64_REGEX.test(message.sha256)) {
    return { valid: false, error: 'sha256 must be 64 hexadecimal characters' };
  }

  // Validate uploadedBy if present
  if (message.uploadedBy !== undefined) {
    if (typeof message.uploadedBy !== 'string') {
      return { valid: false, error: 'uploadedBy must be a string' };
    }
    if (!HEX_64_REGEX.test(message.uploadedBy)) {
      return { valid: false, error: 'uploadedBy must be a valid nostr pubkey (64 hex characters)' };
    }
  }

  // Validate uploadedAt
  if (!message.uploadedAt || typeof message.uploadedAt !== 'number') {
    return { valid: false, error: 'uploadedAt is required and must be a number' };
  }

  if (message.videoSealPayload !== undefined) {
    if (message.videoSealPayload !== null && typeof message.videoSealPayload !== 'string') {
      return { valid: false, error: 'videoSealPayload must be null or a string' };
    }
    if (typeof message.videoSealPayload === 'string' && !HEX_64_REGEX.test(message.videoSealPayload)) {
      return { valid: false, error: 'videoSealPayload must be null or 64 hexadecimal characters' };
    }
  }

  if (message.videoSealBitAccuracy !== undefined) {
    if (message.videoSealBitAccuracy !== null && typeof message.videoSealBitAccuracy !== 'number') {
      return { valid: false, error: 'videoSealBitAccuracy must be null or a number' };
    }
    if (
      typeof message.videoSealBitAccuracy === 'number'
      && (!Number.isFinite(message.videoSealBitAccuracy)
        || message.videoSealBitAccuracy < 0
        || message.videoSealBitAccuracy > 1)
    ) {
      return { valid: false, error: 'videoSealBitAccuracy must be null or a number between 0 and 1' };
    }
  }

  // Metadata is optional, no validation needed

  return { valid: true, data: message };
}
