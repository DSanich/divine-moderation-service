// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for scripts/sweep-creator-deletes.mjs — pure helpers + main() with injected deps.
// ABOUTME: Vitest runs under @cloudflare/vitest-pool-workers; nodejs_compat is on so node:child_process imports resolve.

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  buildSelectCandidatesSql,
  buildSelectUnprocessableSql,
  buildSelectPermanentFailuresSql,
  buildUpdateStampSql,
  validateSha256
} from './sweep-creator-deletes.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('parseArgs', () => {
  it('returns defaults when no flags given', () => {
    const cfg = parseArgs([]);
    expect(cfg).toEqual({
      dryRun: false,
      since: null,
      until: null,
      concurrency: 5,
      limit: null,
      blossomWebhookUrl: 'https://media.divine.video/admin/moderate',
      d1Database: 'divine-moderation-decisions-prod'
    });
  });

  it('parses --dry-run as boolean', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --since and --until as ISO strings via Date round-trip', () => {
    const cfg = parseArgs(['--since=2026-04-01T00:00:00.000Z', '--until=2026-04-17T00:00:00.000Z']);
    expect(cfg.since).toBe('2026-04-01T00:00:00.000Z');
    expect(cfg.until).toBe('2026-04-17T00:00:00.000Z');
  });

  it('rejects an unparseable --since', () => {
    expect(() => parseArgs(['--since=not-a-date'])).toThrow(/since/i);
  });

  it('parses --concurrency as positive integer', () => {
    expect(parseArgs(['--concurrency=10']).concurrency).toBe(10);
  });

  it('rejects --concurrency=0', () => {
    expect(() => parseArgs(['--concurrency=0'])).toThrow(/concurrency/i);
  });

  it('rejects --concurrency=-1', () => {
    expect(() => parseArgs(['--concurrency=-1'])).toThrow(/concurrency/i);
  });

  it('parses --limit as non-negative integer', () => {
    expect(parseArgs(['--limit=100']).limit).toBe(100);
  });

  it('rejects --limit=foo', () => {
    expect(() => parseArgs(['--limit=foo'])).toThrow(/limit/i);
  });

  it('parses --blossom-webhook-url and --d1-database overrides', () => {
    const cfg = parseArgs(['--blossom-webhook-url=http://localhost:7676/admin/moderate', '--d1-database=test-db']);
    expect(cfg.blossomWebhookUrl).toBe('http://localhost:7676/admin/moderate');
    expect(cfg.d1Database).toBe('test-db');
  });
});

describe('validateSha256', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(validateSha256(SHA_A)).toBe(SHA_A);
  });
  it('rejects uppercase', () => {
    expect(() => validateSha256(SHA_A.toUpperCase())).toThrow(/sha256/i);
  });
  it('rejects shorter than 64', () => {
    expect(() => validateSha256('a'.repeat(63))).toThrow(/sha256/i);
  });
  it('rejects non-hex characters', () => {
    expect(() => validateSha256('z'.repeat(64))).toThrow(/sha256/i);
  });
  it('rejects null/undefined', () => {
    expect(() => validateSha256(null)).toThrow(/sha256/i);
    expect(() => validateSha256(undefined)).toThrow(/sha256/i);
  });
});

describe('buildSelectCandidatesSql', () => {
  it('builds the base select with no optional filters', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: null, limit: null });
    expect(sql).toContain("WHERE status = 'success'");
    expect(sql).toContain('AND physical_deleted_at IS NULL');
    expect(sql).toContain('AND blob_sha256 IS NOT NULL');
    expect(sql).not.toContain('completed_at >=');
    expect(sql).not.toContain('completed_at <');
    expect(sql).not.toContain('LIMIT');
  });

  it('includes since when provided', () => {
    const sql = buildSelectCandidatesSql({ since: '2026-04-01T00:00:00.000Z', until: null, limit: null });
    expect(sql).toContain("AND completed_at >= '2026-04-01T00:00:00.000Z'");
  });

  it('includes until when provided', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: '2026-04-17T00:00:00.000Z', limit: null });
    expect(sql).toContain("AND completed_at < '2026-04-17T00:00:00.000Z'");
  });

  it('includes LIMIT when provided', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: null, limit: 50 });
    expect(sql).toMatch(/LIMIT 50\b/);
  });
});

describe('buildSelectUnprocessableSql', () => {
  it('builds select for status=success rows with NULL sha', () => {
    const sql = buildSelectUnprocessableSql();
    expect(sql).toContain("WHERE status = 'success'");
    expect(sql).toContain('AND blob_sha256 IS NULL');
  });
});

describe('buildSelectPermanentFailuresSql', () => {
  it('builds select for status LIKE failed:permanent:*', () => {
    const sql = buildSelectPermanentFailuresSql();
    expect(sql).toContain("WHERE status LIKE 'failed:permanent:%'");
  });
});

describe('buildUpdateStampSql', () => {
  it('builds an UPDATE with IN-list and NULL guard', () => {
    const sql = buildUpdateStampSql([SHA_A, SHA_B], '2026-04-17T20:00:00.000Z');
    expect(sql).toContain("SET physical_deleted_at = '2026-04-17T20:00:00.000Z'");
    expect(sql).toContain(`WHERE blob_sha256 IN ('${SHA_A}', '${SHA_B}')`);
    expect(sql).toContain('AND physical_deleted_at IS NULL');
  });

  it('rejects an empty sha list (caller bug)', () => {
    expect(() => buildUpdateStampSql([], '2026-04-17T20:00:00.000Z')).toThrow(/empty/i);
  });

  it('rejects when any sha fails validation', () => {
    expect(() => buildUpdateStampSql([SHA_A, 'not-hex'], '2026-04-17T20:00:00.000Z')).toThrow(/sha256/i);
  });

  it('rejects an invalid timestamp', () => {
    expect(() => buildUpdateStampSql([SHA_A], 'not-iso')).toThrow(/timestamp/i);
  });
});

import { runWithConcurrency } from './sweep-creator-deletes.mjs';

describe('runWithConcurrency', () => {
  it('runs all items and returns one result per input', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 2, async x => x * 10);
    expect(results.length).toBe(5);
    expect(results.map(r => r.value).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects concurrency cap (never more than N in flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    };
    await runWithConcurrency(new Array(20).fill(0), 3, work);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('isolates per-item errors — one failure does not poison the rest', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrency(items, 2, async x => {
      if (x === 2) throw new Error('boom');
      return x;
    });
    expect(results.length).toBe(3);
    const byInput = Object.fromEntries(results.map(r => [r.input, r]));
    expect(byInput[1].value).toBe(1);
    expect(byInput[2].error.message).toBe('boom');
    expect(byInput[3].value).toBe(3);
  });

  it('returns immediately on empty input', async () => {
    const results = await runWithConcurrency([], 5, async () => { throw new Error('should not run'); });
    expect(results).toEqual([]);
  });
});

import { callBlossomDelete, classifyDeleteResult } from './sweep-creator-deletes.mjs';

const SHA_C = 'c'.repeat(64);

function makeFakeNotify(impl) {
  const calls = [];
  const fn = async (sha256, action, env) => {
    calls.push({ sha256, action, env });
    return impl({ sha256, action, env });
  };
  fn.calls = calls;
  return fn;
}

describe('callBlossomDelete', () => {
  it('passes sha + DELETE + env to notifyBlossom and returns a normalized result', async () => {
    const notify = makeFakeNotify(() => ({
      success: true,
      status: 200,
      result: { status: 'success', physical_delete_enabled: true, physical_deleted: true }
    }));
    const cfg = {
      blossomWebhookUrl: 'https://example/admin/moderate',
      blossomWebhookSecret: 'secret-xyz'
    };
    const r = await callBlossomDelete(SHA_C, cfg, notify);
    expect(notify.calls).toEqual([{
      sha256: SHA_C,
      action: 'DELETE',
      env: { BLOSSOM_WEBHOOK_URL: cfg.blossomWebhookUrl, BLOSSOM_WEBHOOK_SECRET: cfg.blossomWebhookSecret }
    }]);
    expect(r.ok).toBe(true);
    expect(r.body.physical_deleted).toBe(true);
  });

  it('surfaces network error from notifyBlossom', async () => {
    const notify = makeFakeNotify(() => ({ success: false, networkError: true, error: 'ECONNRESET' }));
    const r = await callBlossomDelete(SHA_C, { blossomWebhookUrl: 'u', blossomWebhookSecret: 's' }, notify);
    expect(r.ok).toBe(false);
    expect(r.networkError).toBe(true);
  });

  it('surfaces 5xx HTTP error', async () => {
    const notify = makeFakeNotify(() => ({ success: false, error: 'HTTP 502: bad', status: 502 }));
    const r = await callBlossomDelete(SHA_C, { blossomWebhookUrl: 'u', blossomWebhookSecret: 's' }, notify);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
  });
});

describe('classifyDeleteResult', () => {
  it('success when ok && body.status==="success" && body.physical_deleted===true', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'success', physical_delete_enabled: true, physical_deleted: true }
    })).toEqual({ kind: 'success' });
  });

  it('flag-off pre-flight signal when physical_delete_enabled===false', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'success', physical_delete_enabled: false, physical_deleted: false }
    })).toEqual({ kind: 'flag-off' });
  });

  it('failure when body.status==="error"', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'error', error: 'gcs delete failed' }
    })).toEqual({ kind: 'failure', reason: 'gcs delete failed' });
  });

  it('failure when 200 but physical_deleted===false (and flag was on)', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { status: 'success', physical_delete_enabled: true, physical_deleted: false }
    })).toEqual({ kind: 'failure', reason: 'physical_deleted=false despite flag on' });
  });

  it('auth-failure on 401/403', () => {
    expect(classifyDeleteResult({ ok: false, status: 401 })).toEqual({ kind: 'auth-failure' });
    expect(classifyDeleteResult({ ok: false, status: 403 })).toEqual({ kind: 'auth-failure' });
  });

  it('unreachable on 5xx', () => {
    expect(classifyDeleteResult({ ok: false, status: 502 }).kind).toBe('unreachable');
  });

  it('unreachable on networkError', () => {
    expect(classifyDeleteResult({ ok: false, networkError: true, error: 'ECONNRESET' }).kind).toBe('unreachable');
  });
});
