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

export function validateSha256(s) {
  if (typeof s !== 'string' || !SHA256_HEX.test(s)) {
    throw new Error(`Invalid sha256: ${s}`);
  }
  return s;
}

function validateIsoTimestamp(s) {
  if (typeof s !== 'string') throw new Error(`Invalid timestamp: ${s}`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== s) {
    throw new Error(`Invalid timestamp: ${s}`);
  }
  return s;
}

export function buildSelectCandidatesSql({ since, until, limit }) {
  let sql =
    "SELECT kind5_id, target_event_id, blob_sha256, completed_at FROM creator_deletions" +
    " WHERE status = 'success'" +
    " AND physical_deleted_at IS NULL" +
    " AND blob_sha256 IS NOT NULL";
  if (since) sql += ` AND completed_at >= '${validateIsoTimestamp(since)}'`;
  if (until) sql += ` AND completed_at < '${validateIsoTimestamp(until)}'`;
  if (limit != null) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid limit: ${limit}`);
    sql += ` LIMIT ${limit}`;
  }
  sql += ';';
  return sql;
}

export function buildSelectUnprocessableSql() {
  return (
    "SELECT kind5_id, target_event_id, creator_pubkey, completed_at FROM creator_deletions" +
    " WHERE status = 'success'" +
    " AND blob_sha256 IS NULL;"
  );
}

export function buildSelectPermanentFailuresSql() {
  return (
    "SELECT kind5_id, target_event_id, creator_pubkey, status, last_error FROM creator_deletions" +
    " WHERE status LIKE 'failed:permanent:%';"
  );
}

export function buildUpdateStampSql(shas, timestamp) {
  if (!Array.isArray(shas) || shas.length === 0) {
    throw new Error('buildUpdateStampSql called with empty sha list');
  }
  validateIsoTimestamp(timestamp);
  for (const s of shas) validateSha256(s);
  const inList = shas.map(s => `'${s}'`).join(', ');
  return (
    `UPDATE creator_deletions SET physical_deleted_at = '${timestamp}'` +
    ` WHERE blob_sha256 IN (${inList})` +
    ` AND physical_deleted_at IS NULL;`
  );
}
