// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for scripts/sweep-creator-deletes.mjs — pure helpers + main() with injected deps.
// ABOUTME: Vitest runs under @cloudflare/vitest-pool-workers; nodejs_compat is on so node:child_process imports resolve.

import { describe, it, expect } from 'vitest';
import { parseArgs } from './sweep-creator-deletes.mjs';

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
