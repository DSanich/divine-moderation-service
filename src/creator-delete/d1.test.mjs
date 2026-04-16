// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for D1 helpers — claimRow idempotency + decideAction state machine for all row statuses.
// ABOUTME: Uses an in-memory fake D1 (makeFakeD1) defined locally; extraction to shared module happens in Task 4.

import { describe, it, expect, beforeEach } from 'vitest';
import { claimRow, readRow, updateToSuccess, updateToFailed, decideAction } from './d1.mjs';

// Test helper: in-memory D1 fake with the same schema as creator_deletions.
function makeFakeD1() {
  const rows = new Map(); // key: `${kind5_id}:${target_event_id}`
  return {
    rows,
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...args) { this._binds = args; return this; },
        async run() {
          if (this._sql.startsWith('INSERT')) {
            const [kind5_id, target_event_id, creator_pubkey, accepted_at] = this._binds;
            const key = `${kind5_id}:${target_event_id}`;
            if (rows.has(key)) {
              return { meta: { changes: 0, rows_written: 0 } };
            }
            rows.set(key, { kind5_id, target_event_id, creator_pubkey, status: 'accepted', accepted_at, retry_count: 0, last_error: null, blob_sha256: null, completed_at: null });
            return { meta: { changes: 1, rows_written: 1 } };
          }
          if (this._sql.startsWith('UPDATE')) {
            const target_key = `${this._binds[this._binds.length - 2]}:${this._binds[this._binds.length - 1]}`;
            const existing = rows.get(target_key);
            if (existing) {
              // Very simplified: we're just testing the wrappers, not SQL correctness.
              rows.set(target_key, { ...existing, _updated: true });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (this._sql.startsWith('SELECT')) {
            const key = `${this._binds[0]}:${this._binds[1]}`;
            return rows.get(key) || null;
          }
          return null;
        }
      };
    }
  };
}

describe('claimRow', () => {
  let db;
  beforeEach(() => { db = makeFakeD1(); });

  it('claims a new row and returns claimed: true', async () => {
    const now = new Date().toISOString();
    const result = await claimRow(db, {
      kind5_id: 'k1',
      target_event_id: 't1',
      creator_pubkey: 'pub1',
      accepted_at: now
    });
    expect(result.claimed).toBe(true);
    expect(result.existing).toBeNull();
  });

  it('does not claim when row already exists; returns existing', async () => {
    const now = new Date().toISOString();
    await claimRow(db, { kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', accepted_at: now });
    const second = await claimRow(db, { kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', accepted_at: new Date().toISOString() });
    expect(second.claimed).toBe(false);
    expect(second.existing).toMatchObject({ kind5_id: 'k1', target_event_id: 't1', status: 'accepted' });
  });
});

describe('decideAction', () => {
  it('proceed when no row exists', () => {
    expect(decideAction(null)).toBe('proceed');
  });

  it('skip_success on terminal success', () => {
    expect(decideAction({ status: 'success' })).toBe('skip_success');
  });

  it('skip_permanent_failure on permanent failure', () => {
    expect(decideAction({ status: 'failed:permanent:blossom_400' })).toBe('skip_permanent_failure');
  });

  it('skip_in_progress when accepted and recent', () => {
    const now = Date.now();
    const existing = {
      status: 'accepted',
      accepted_at: new Date(now - 5_000).toISOString()
    };
    expect(decideAction(existing, { now })).toBe('skip_in_progress');
  });

  it('proceed when accepted but stale (>30s)', () => {
    const now = Date.now();
    const existing = {
      status: 'accepted',
      accepted_at: new Date(now - 60_000).toISOString()
    };
    expect(decideAction(existing, { now })).toBe('proceed');
  });

  it('proceed when failed:transient and retries remain', () => {
    expect(decideAction({ status: 'failed:transient:blossom_5xx', retry_count: 2 })).toBe('proceed');
  });

  it('skip when failed:transient and retries exhausted', () => {
    expect(decideAction({ status: 'failed:transient:blossom_5xx', retry_count: 5 })).toBe('skip_permanent_failure');
  });
});
