#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Validation-window physical-delete sweep for creator-deleted blobs (blossom#90).
// ABOUTME: Reads creator_deletions from D1, asks Blossom to destroy bytes, stamps physical_deleted_at.

const DEFAULT_BLOSSOM_WEBHOOK_URL = 'https://media.divine.video/admin/moderate';
const DEFAULT_D1_DATABASE = 'divine-moderation-decisions-prod';
const DEFAULT_CONCURRENCY = 5;
const FLUSH_BATCH_SIZE = 100;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function getFlag(argv, name) {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

function validateIso(value, fieldName) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be ISO 8601)`);
  }
  return d.toISOString();
}

function validatePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be positive integer)`);
  }
  return n;
}

function validateNonNegativeInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be non-negative integer)`);
  }
  return n;
}

export function parseArgs(argv) {
  const dryRun = getFlag(argv, 'dry-run') === true;
  const since = validateIso(getFlag(argv, 'since') || null, 'since');
  const until = validateIso(getFlag(argv, 'until') || null, 'until');

  const rawConcurrency = getFlag(argv, 'concurrency');
  const concurrency = rawConcurrency
    ? validatePositiveInt(rawConcurrency, 'concurrency')
    : DEFAULT_CONCURRENCY;

  const rawLimit = getFlag(argv, 'limit');
  const limit = rawLimit ? validateNonNegativeInt(rawLimit, 'limit') : null;

  const blossomWebhookUrl = getFlag(argv, 'blossom-webhook-url') || DEFAULT_BLOSSOM_WEBHOOK_URL;
  const d1Database = getFlag(argv, 'd1-database') || DEFAULT_D1_DATABASE;

  return { dryRun, since, until, concurrency, limit, blossomWebhookUrl, d1Database };
}
