// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for GET /api/delete-status/{kind5_id} — happy path + 401 / 403 / 404 / 429.
// ABOUTME: Uses makeFakeD1/makeFakeKV from ./test-helpers.mjs; seeds D1 via rows.set() to bypass INSERT fake limitations.

import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { handleStatusQuery } from './status-endpoint.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { makeFakeD1, makeFakeKV } from './test-helpers.mjs';

const KIND5_A = 'a'.repeat(64);
const KIND5_B = 'b'.repeat(64);

describe('handleStatusQuery', () => {
  let sk, pk, deps;

  beforeEach(() => {
    sk = generateSecretKey();
    pk = getPublicKey(sk);
    deps = { db: makeFakeD1(), kv: makeFakeKV() };
  });

  function signNip98Get(url) {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', url], ['method', 'GET']],
      content: ''
    }, sk);
    return `Nostr ${btoa(JSON.stringify(event))}`;
  }

  it('returns 200 with target rows for the caller pubkey', async () => {
    deps.db.rows.set(`${KIND5_A}:t1`, {
      kind5_id: KIND5_A,
      target_event_id: 't1',
      creator_pubkey: pk,
      status: 'success',
      accepted_at: new Date().toISOString(),
      blob_sha256: 'c'.repeat(64),
      retry_count: 0,
      last_error: null,
      completed_at: new Date().toISOString()
    });

    const url = `https://moderation-api.divine.video/api/delete-status/${KIND5_A}`;
    const request = new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } });
    const response = await handleStatusQuery(request, deps);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind5_id).toBe(KIND5_A);
    expect(body.targets[0]).toMatchObject({ target_event_id: 't1', status: 'success' });
  });

  it('returns 400 on malformed kind5_id', async () => {
    const url = 'https://moderation-api.divine.video/api/delete-status/not-a-hex-id';
    const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
    expect(response.status).toBe(400);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const url = `https://moderation-api.divine.video/api/delete-status/${KIND5_A}`;
    const response = await handleStatusQuery(new Request(url, { method: 'GET' }), deps);
    expect(response.status).toBe(401);
  });

  it('returns 429 on IP rate limit before NIP-98 validation', async () => {
    for (let i = 0; i < 60; i++) {
      await checkRateLimit(deps.kv, { key: 'status-ip:203.0.113.10', limit: 60, windowSeconds: 60 });
    }
    const url = `https://moderation-api.divine.video/api/delete-status/${KIND5_A}`;
    const response = await handleStatusQuery(new Request(url, {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '203.0.113.10' }
    }), deps);
    expect(response.status).toBe(429);
  });

  it('returns 404 when no rows exist for the kind5_id', async () => {
    const url = `https://moderation-api.divine.video/api/delete-status/${KIND5_B}`;
    const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
    expect(response.status).toBe(404);
  });

  it('returns 403 when caller pubkey does not match row creator_pubkey', async () => {
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    deps.db.rows.set(`${KIND5_B}:t1`, {
      kind5_id: KIND5_B,
      target_event_id: 't1',
      creator_pubkey: otherPk,
      status: 'success',
      accepted_at: new Date().toISOString(),
      blob_sha256: null,
      retry_count: 0,
      last_error: null,
      completed_at: null
    });

    const url = `https://moderation-api.divine.video/api/delete-status/${KIND5_B}`;
    const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
    expect(response.status).toBe(403);
  });

  it('returns 429 when per-pubkey rate limit exceeded', async () => {
    for (let i = 0; i < 120; i++) {
      await checkRateLimit(deps.kv, { key: `status:${pk}`, limit: 120, windowSeconds: 60 });
    }
    const url = `https://moderation-api.divine.video/api/delete-status/${KIND5_A}`;
    const response = await handleStatusQuery(new Request(url, { method: 'GET', headers: { Authorization: signNip98Get(url) } }), deps);
    expect(response.status).toBe(429);
  });
});
