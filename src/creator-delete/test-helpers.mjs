// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared test helpers for creator-delete unit tests — in-memory D1 fake.
// ABOUTME: makeFakeD1 mirrors production SQL arity (see src/creator-delete/d1.mjs claimRow).

// Test helper: in-memory D1 fake with the same schema as creator_deletions.
export function makeFakeD1() {
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
