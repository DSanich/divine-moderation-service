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

export async function runWithConcurrency(items, concurrency, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const input = items[i];
      try {
        const value = await fn(input);
        results[i] = { input, value };
      } catch (error) {
        results[i] = { input, error };
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

import { notifyBlossom as defaultNotify } from '../src/blossom-client.mjs';

/**
 * Wraps notifyBlossom() so the script reuses the live-pipeline request shape and headers.
 * notifyImpl is injectable for tests.
 */
export async function callBlossomDelete(sha256, cfg, notifyImpl = defaultNotify) {
  const env = {
    BLOSSOM_WEBHOOK_URL: cfg.blossomWebhookUrl,
    BLOSSOM_WEBHOOK_SECRET: cfg.blossomWebhookSecret
  };
  const r = await notifyImpl(sha256, 'DELETE', env);
  if (r.success) {
    return { ok: true, status: r.status, body: r.result };
  }
  return {
    ok: false,
    status: r.status,
    networkError: !!r.networkError,
    error: r.error
  };
}

/**
 * Classifies a Blossom call result into the action the script should take.
 * Used by both pre-flight and per-row sweep logic.
 */
export function classifyDeleteResult(r) {
  if (r.ok) {
    const b = r.body || {};
    if (b.physical_delete_enabled === false) return { kind: 'flag-off' };
    if (b.status === 'error') return { kind: 'failure', reason: b.error || 'blossom returned status=error' };
    if (b.status === 'success' && b.physical_deleted === true) return { kind: 'success' };
    return { kind: 'failure', reason: 'physical_deleted=false despite flag on' };
  }
  if (r.status === 401 || r.status === 403) return { kind: 'auth-failure' };
  if (r.networkError) return { kind: 'unreachable', reason: r.error || 'network error' };
  if (r.status >= 500) return { kind: 'unreachable', reason: `HTTP ${r.status}` };
  return { kind: 'failure', reason: r.error || `HTTP ${r.status}` };
}

/**
 * Default runner used when the script runs as a CLI. Tests inject a fake.
 * Uses spawnSync (args is an array, not a string — no shell interpretation).
 *
 * The node:child_process import is deferred via dynamic import() so the test
 * runner (Cloudflare Workers pool) does not try to resolve it during module
 * collection — Workers compat does not provide node:child_process even with
 * nodejs_compat. Tests inject a fake runner and never reach this function.
 */
export async function defaultRunner({ command, args }) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? 0 };
}

async function runWranglerD1(cfg, sql, runner) {
  const args = ['d1', 'execute', cfg.d1Database, '--remote', '--json', '--command', sql];
  const r = await runner({ command: 'wrangler', args });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`failed to parse wrangler stdout as JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || !parsed[0]) return [];
  return parsed[0].results || [];
}

export async function fetchCandidates(cfg, runner = defaultRunner) {
  const sql = buildSelectCandidatesSql({ since: cfg.since, until: cfg.until, limit: cfg.limit });
  return runWranglerD1(cfg, sql, runner);
}

export async function fetchUnprocessable(cfg, runner = defaultRunner) {
  return runWranglerD1(cfg, buildSelectUnprocessableSql(), runner);
}

export async function fetchPermanentFailures(cfg, runner = defaultRunner) {
  return runWranglerD1(cfg, buildSelectPermanentFailuresSql(), runner);
}

export async function flushDeletedAt(shas, cfg, runner = defaultRunner, timestamp = new Date().toISOString()) {
  if (!shas || shas.length === 0) return;
  const sql = buildUpdateStampSql(shas, timestamp);
  await runWranglerD1(cfg, sql, runner);
}

export class PreflightAbort extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'PreflightAbort';
    this.reason = reason;
  }
}

export async function runPreflight(sha256, cfg, notifyImpl = defaultNotify) {
  const r = await callBlossomDelete(sha256, cfg, notifyImpl);
  const c = classifyDeleteResult(r);
  if (c.kind === 'success') return { kind: 'success' };
  if (c.kind === 'flag-off') {
    throw new PreflightAbort('flag-off',
      'Blossom did not byte-delete because ENABLE_PHYSICAL_DELETE is off. ' +
      'Flip the flag in Blossom config store before sweeping. No D1 writes occurred.');
  }
  if (c.kind === 'auth-failure') {
    throw new PreflightAbort('auth-failure',
      'Blossom rejected auth — check BLOSSOM_WEBHOOK_SECRET. No D1 writes occurred.');
  }
  if (c.kind === 'unreachable') {
    throw new PreflightAbort('unreachable',
      `Blossom unreachable: ${c.reason}. No D1 writes occurred.`);
  }
  throw new PreflightAbort('failure',
    `Blossom returned a failure on the first candidate: ${c.reason}. No D1 writes occurred.`);
}

function nowIso() {
  return new Date().toISOString();
}

function emitJsonLine(obj) {
  console.log(JSON.stringify(obj));
}

/**
 * Bulk sweep over candidates. Stamps via flushImpl in batches of FLUSH_BATCH_SIZE.
 * Per-row JSONL outcome lines are emitted to stdout for grep/jq.
 *
 * Returns { successes, failures } as arrays of {row, body?, error?, status?}.
 */
export async function sweepCandidates(candidates, cfg, notifyImpl = defaultNotify, flushImpl = null) {
  const successes = [];
  const failures = [];
  let pending = [];
  const flush = flushImpl || (async (shas) => { await flushDeletedAt(shas, cfg); });

  const results = await runWithConcurrency(candidates, cfg.concurrency, async (row) => {
    return callBlossomDelete(row.blob_sha256, cfg, notifyImpl);
  });

  for (const r of results) {
    const row = r.input;
    if (r.error) {
      failures.push({ row, error: r.error.message });
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'failure', error: r.error.message });
      continue;
    }
    const c = classifyDeleteResult(r.value);
    if (c.kind === 'success') {
      successes.push({ row, body: r.value.body });
      pending.push(row.blob_sha256);
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'success', http: r.value.status, physical_deleted: true });
      if (pending.length >= FLUSH_BATCH_SIZE) {
        await flush(pending);
        pending = [];
      }
    } else {
      failures.push({ row, error: c.reason || c.kind, status: r.value.status });
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'failure', http: r.value.status, error: c.reason || c.kind });
    }
  }

  if (pending.length > 0) {
    await flush(pending);
  }
  return { successes, failures };
}

export function summarize({ candidates, successes, failures, unprocessable, permanentFailures }) {
  return {
    total: candidates.length,
    stamped: successes.length,
    failed: failures.length,
    unprocessableCount: unprocessable.length,
    permanentFailureCount: permanentFailures.length,
    successes,
    failures,
    unprocessable,
    permanentFailures
  };
}

export function computeExitCode(s) {
  if (s.failed > 0 || s.unprocessableCount > 0 || s.permanentFailureCount > 0) return 1;
  return 0;
}

export function printSummary(s) {
  console.log('\n=== SUMMARY ===');
  console.log(`Total candidates fetched:      ${s.total}`);
  console.log(`Bytes destroyed + stamped:     ${s.stamped}`);
  console.log(`Failed (will retry next run):  ${s.failed}`);
  console.log(`Unprocessable (NULL sha256):   ${s.unprocessableCount}`);
  console.log(`Permanent failures (manual):   ${s.permanentFailureCount}`);

  if (s.failures.length > 0) {
    console.log('\n=== FAILURES (will retry) ===');
    for (const f of s.failures) {
      console.log(`sha=${f.row.blob_sha256} http=${f.status ?? '-'} kind5=${f.row.kind5_id}: ${f.error}`);
    }
  }
  if (s.unprocessable.length > 0) {
    console.log('\n=== UNPROCESSABLE (creator intent unfulfilled, NULL sha256) ===');
    for (const u of s.unprocessable) {
      console.log(`kind5=${u.kind5_id} target=${u.target_event_id} creator=${u.creator_pubkey} completed_at=${u.completed_at}`);
    }
  }
  if (s.permanentFailures.length > 0) {
    console.log('\n=== PERMANENT FAILURES (creator intent unfulfilled, status=failed:permanent:*) ===');
    for (const p of s.permanentFailures) {
      console.log(`kind5=${p.kind5_id} target=${p.target_event_id} creator=${p.creator_pubkey} status=${p.status} last_error=${p.last_error}`);
    }
  }
}
