#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Validation-window physical-delete sweep for creator-deleted blobs (blossom#90).
// ABOUTME: Reads creator_deletions from D1, asks Blossom to destroy bytes, stamps physical_deleted_at.

const DEFAULT_BLOSSOM_WEBHOOK_URL = 'https://media.divine.video/admin/moderate';
const DEFAULT_D1_DATABASE = 'blossom-webhook-events';
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
  const local = getFlag(argv, 'local') === true;
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

  return { dryRun, local, since, until, concurrency, limit, blossomWebhookUrl, d1Database };
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

export async function runWithConcurrency(items, concurrency, fn, drainCheck = null) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      if (drainCheck && drainCheck()) return;  // honor drain before pulling next item
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
  // Compact: drain leaves holes (unstarted items) in results. Filter them out
  // so downstream code sees only items that actually ran.
  return results.filter(r => r !== undefined);
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
 *
 * CONTRACT: this reads the wire shape emitted by divine-blossom at
 * `src/admin.rs:923-930` and `src/main.rs:4795-4802` (as of 2026-04-18):
 *   { success: true, sha256, old_status, new_status: "deleted",
 *     physical_deleted: bool, physical_delete_skipped: bool }
 *
 * physical_delete_skipped === true means ENABLE_PHYSICAL_DELETE was OFF on
 * Blossom (the negation is emitted server-side). For error cases Blossom
 * returns non-2xx; a 2xx-with-success:false is not in the current contract.
 *
 * If Blossom's response shape changes, update this function and its tests
 * in lockstep. The test fixtures are authored from this same contract and
 * will not catch drift on their own.
 */
export function classifyDeleteResult(r) {
  if (r.ok) {
    const b = r.body || {};
    // flag-off checked first: the signal is more actionable for the operator
    // ("turn the flag on and re-run") than a generic failure reason, and
    // catching it mid-sweep lets us abort cleanly instead of silently logging
    // per-row failures while bytes remain on GCS.
    if (b.physical_delete_skipped === true) return { kind: 'flag-off' };
    if (b.success === true && b.physical_deleted === true) return { kind: 'success' };
    // 2xx with an unexpected body shape — treat as failure so the row stays
    // unstamped and surfaces in the summary for manual investigation.
    return { kind: 'failure', reason: `unexpected Blossom response: ${JSON.stringify(b).slice(0, 200)}` };
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
  const remoteOrLocal = cfg.local ? '--local' : '--remote';
  const args = ['d1', 'execute', cfg.d1Database, remoteOrLocal, '--json', '--command', sql];
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
 * D1 write failure during sweep. Carries the in-memory pending sha list at the
 * point of failure so main() can print them for manual reconciliation. Bytes
 * for these shas were destroyed (Blossom returned physical_deleted=true) but
 * D1 stamping did not complete — re-running the sweep is safe and will stamp
 * them on the next pass (Blossom DELETE on already-gone bytes still returns
 * success).
 */
export class D1WriteAbort extends Error {
  constructor(unflushedShas, originalError) {
    super(`flushDeletedAt failed: ${originalError.message}`);
    this.name = 'D1WriteAbort';
    this.unflushedShas = unflushedShas;
    this.originalError = originalError;
  }
}

/**
 * Blossom returned physical_delete_skipped=true mid-sweep, meaning someone
 * toggled ENABLE_PHYSICAL_DELETE off after pre-flight passed. Abort the whole
 * sweep rather than log per-row failures while bytes remain on GCS. main()
 * exits 2 (same code as pre-flight flag-off) so the operator's response is
 * identical: flip the flag back on and re-run.
 */
export class MidRunFlagOff extends Error {
  constructor(sha256) {
    super(`Blossom reported physical_delete_skipped=true for ${sha256} mid-sweep — ENABLE_PHYSICAL_DELETE was toggled off.`);
    this.name = 'MidRunFlagOff';
    this.sha256 = sha256;
  }
}

/**
 * Bulk sweep over candidates. Stamps via flushImpl in batches of FLUSH_BATCH_SIZE.
 * Per-row JSONL outcome lines are emitted to stdout for grep/jq.
 *
 * Returns { successes, failures } as arrays of {row, body?, error?, status?}.
 * Throws D1WriteAbort if a flush fails mid-sweep — caller should print the
 * unflushedShas and exit 4 per the spec.
 */
export async function sweepCandidates(candidates, cfg, notifyImpl = defaultNotify, flushImpl = null, isDrainingImpl = isDraining) {
  const successes = [];
  const failures = [];
  let pending = [];
  const flush = flushImpl || (async (shas) => { await flushDeletedAt(shas, cfg); });

  async function flushOrAbort() {
    if (pending.length === 0) return;
    try {
      await flush(pending);
      pending = [];
    } catch (e) {
      throw new D1WriteAbort([...pending], e);
    }
  }

  // `runWithConcurrency` honors the drain callback at the scheduler level:
  // once `isDrainingImpl()` returns true, no new items are dequeued but all
  // in-flight work is awaited and returned. The result list below therefore
  // already reflects everything that actually ran (successfully or not),
  // including completions after the first SIGINT. Do NOT break out of the
  // loop on drain — that was the pre-review bug (#106 review from Liz): it
  // dropped post-signal successes before they could be flushed, so the
  // partial summary understated bytes actually deleted.
  const results = await runWithConcurrency(candidates, cfg.concurrency, async (row) => {
    return callBlossomDelete(row.blob_sha256, cfg, notifyImpl);
  }, isDrainingImpl);

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
        await flushOrAbort();
      }
    } else if (c.kind === 'flag-off') {
      // Config toggled off between pre-flight and now. Flush what we have
      // and abort — do not keep calling Blossom and logging failures while
      // bytes remain on GCS.
      await flushOrAbort();
      throw new MidRunFlagOff(row.blob_sha256);
    } else {
      failures.push({ row, error: c.reason || c.kind, status: r.value.status });
      emitJsonLine({ ts: nowIso(), sha: row.blob_sha256, kind5: row.kind5_id, target: row.target_event_id, outcome: 'failure', http: r.value.status, error: c.reason || c.kind });
    }
  }

  await flushOrAbort();
  return { successes, failures };
}

export function summarize({ candidates, successes, failures, unprocessable, permanentFailures, surfacingFailed = false }) {
  return {
    total: candidates.length,
    stamped: successes.length,
    failed: failures.length,
    unprocessableCount: unprocessable.length,
    permanentFailureCount: permanentFailures.length,
    surfacingFailed,
    successes,
    failures,
    unprocessable,
    permanentFailures
  };
}

export function computeExitCode(s) {
  if (s.failed > 0 || s.unprocessableCount > 0 || s.permanentFailureCount > 0) return 1;
  // Surfacing-query failure: the sweep itself may have been clean, but
  // operator visibility into unprocessable/permanent-failure rows is gone.
  // Exit non-zero so the run doesn't look fully successful.
  if (s.surfacingFailed) return 1;
  return 0;
}

export function printSummary(s) {
  console.log('\n=== SUMMARY ===');
  console.log(`Total candidates fetched:      ${s.total}`);
  console.log(`Bytes destroyed + stamped:     ${s.stamped}`);
  console.log(`Failed (will retry next run):  ${s.failed}`);
  console.log(`Unprocessable (NULL sha256):   ${s.unprocessableCount}`);
  console.log(`Permanent failures (manual):   ${s.permanentFailureCount}`);
  if (s.surfacingFailed) {
    console.log(`Surfacing queries:             FAILED (see stderr) — exit code will be non-zero`);
  }

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

function readBlossomSecret() {
  const s = (typeof process !== 'undefined' && process.env) ? process.env.BLOSSOM_WEBHOOK_SECRET : null;
  if (!s) {
    throw new Error('BLOSSOM_WEBHOOK_SECRET env var is required');
  }
  return s;
}

/**
 * Programmatic entrypoint. Returns the exit code (does not call process.exit).
 * Tests inject { runner, notify, blossomWebhookSecret } to drive the flow without shelling out.
 */
export async function main(argv, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const notify = deps.notify || defaultNotify;

  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (e) {
    console.error(`arg error: ${e.message}`);
    return 3;
  }

  try {
    cfg.blossomWebhookSecret = deps.blossomWebhookSecret ?? readBlossomSecret();
  } catch (e) {
    console.error(e.message);
    return 3;
  }

  // Fetch candidates
  let candidates;
  try {
    candidates = await fetchCandidates(cfg, runner);
  } catch (e) {
    console.error(`fetchCandidates failed: ${e.message}`);
    return 3;
  }
  console.error(`Found ${candidates.length} candidate(s) for sweep.`);
  if (cfg.since || cfg.until) {
    console.error(`Window: since=${cfg.since ?? '-'} until=${cfg.until ?? '-'}`);
  }

  // Dry-run gate
  if (cfg.dryRun) {
    for (const r of candidates.slice(0, 20)) {
      console.log(`[dry-run] sha=${r.blob_sha256} kind5=${r.kind5_id} completed_at=${r.completed_at}`);
    }
    if (candidates.length > 20) {
      console.log(`[dry-run] ... and ${candidates.length - 20} more`);
    }
    return 0;
  }

  // Pre-flight (consumes the first candidate when there are any)
  let preflightSuccess = null;
  if (candidates.length > 0) {
    try {
      preflightSuccess = await runPreflight(candidates[0].blob_sha256, cfg, notify);
    } catch (e) {
      if (e instanceof PreflightAbort) {
        console.error(`preflight aborted (${e.reason}): ${e.message}`);
        return 2;
      }
      console.error(`preflight error: ${e.message}`);
      return 2;
    }
  }

  // Sweep remaining (skip the pre-flight row, then stamp it separately).
  //
  // The pre-flight row's stamp happens AFTER the bulk sweep finishes, not in
  // the same flush batch. If the process dies between the bulk-sweep flush
  // and the pre-flight stamp, the pre-flight bytes are gone but the row stays
  // unstamped — re-running picks it up, calls Blossom (idempotent: returns
  // physical_deleted=true on already-gone bytes per Blossom PR #85), then
  // stamps. Same convergence rationale as any unflushed row in the bulk path.
  let sweepResult = { successes: [], failures: [] };
  if (candidates.length > 0) {
    const remaining = candidates.slice(1);
    try {
      sweepResult = await sweepCandidates(remaining, cfg, notify, async (shas) => {
        await flushDeletedAt(shas, cfg, runner);
      });
    } catch (e) {
      if (e instanceof D1WriteAbort) {
        console.error(`D1 write aborted mid-sweep: ${e.originalError.message}`);
        console.error(`Bytes destroyed but rows NOT stamped (${e.unflushedShas.length} shas):`);
        for (const sha of e.unflushedShas) console.error(`  ${sha}`);
        console.error('Re-run the sweep to stamp these rows (Blossom DELETE is idempotent).');
        return 4;
      }
      if (e instanceof MidRunFlagOff) {
        console.error(`mid-run flag-off aborted sweep: ${e.message}`);
        console.error('Re-enable ENABLE_PHYSICAL_DELETE on Blossom and re-run the sweep.');
        return 2;
      }
      throw e;
    }
    if (preflightSuccess) {
      try {
        await flushDeletedAt([candidates[0].blob_sha256], cfg, runner);
      } catch (e) {
        console.error(`D1 write aborted on pre-flight stamp: ${e.message}`);
        console.error(`Bytes destroyed but row NOT stamped (1 sha):`);
        console.error(`  ${candidates[0].blob_sha256}`);
        console.error('Re-run the sweep to stamp this row (Blossom DELETE is idempotent).');
        return 4;
      }
      sweepResult.successes.unshift({ row: candidates[0], body: null });
      console.log(JSON.stringify({ ts: nowIso(), sha: candidates[0].blob_sha256, kind5: candidates[0].kind5_id, target: candidates[0].target_event_id, outcome: 'success', http: 200, physical_deleted: true, source: 'preflight' }));
    }
  }

  // Surfacing queries. If these fail, the operator loses visibility into
  // unprocessable and permanent-failure rows, which is exactly what this
  // script is meant to surface. Treat as a non-zero outcome rather than
  // silently degrading to exit 0 with empty lists.
  let unprocessable = [];
  let permanentFailures = [];
  let surfacingFailed = false;
  try {
    unprocessable = await fetchUnprocessable(cfg, runner);
    permanentFailures = await fetchPermanentFailures(cfg, runner);
  } catch (e) {
    console.error(`surfacing query failed: ${e.message}`);
    surfacingFailed = true;
  }

  // Summary
  const s = summarize({
    candidates,
    successes: sweepResult.successes,
    failures: sweepResult.failures,
    unprocessable,
    permanentFailures,
    surfacingFailed
  });
  printSummary(s);
  return computeExitCode(s);
}

// SIGINT handling — best-effort drain.
// First SIGINT: set DRAINING flag; the orchestrator stops scheduling new flushes once the current
// runWithConcurrency batch settles, then exits with the partial summary.
// Second SIGINT: hard exit 130.
let DRAINING = false;
let SIGINT_COUNT = 0;

function installSigintHandler() {
  process.on('SIGINT', () => {
    SIGINT_COUNT++;
    if (SIGINT_COUNT === 1) {
      DRAINING = true;
      console.error('\n[sweep] SIGINT received — draining in-flight work; press Ctrl-C again to abort.');
    } else {
      console.error('\n[sweep] SIGINT received twice — exiting now.');
      process.exit(130);
    }
  });
}

export function isDraining() { return DRAINING; }

// CLI entrypoint — only runs when invoked directly (not when imported by tests).
const isMain = typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  installSigintHandler();
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`unexpected error: ${err.stack || err.message}`);
      process.exit(99);
    }
  );
}
