// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the POST /api/delete/{kind5_id} handler — happy path + 400/401/403/404/429/202.
// ABOUTME: Uses makeFakeD1/makeFakeKV from ./test-helpers.mjs; injected deps mock Funnelcake + Blossom.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import {
  handleSyncDelete,
  PER_PUBKEY_LIMIT,
  PER_IP_LIMIT,
  RATE_WINDOW_SECONDS
} from './sync-endpoint.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { makeFakeD1, makeFakeKV } from './test-helpers.mjs';

const KIND5_ID = 'a'.repeat(64); // 64-char hex for URL path + kind5.id fixture
const SHA_C = 'c'.repeat(64);    // 64-char hex for blob sha256 (extractSha256 requires)

describe('handleSyncDelete', () => {
  let sk, pk, deps;

  beforeEach(() => {
    sk = generateSecretKey();
    pk = getPublicKey(sk);
    deps = {
      db: makeFakeD1(),
      kv: makeFakeKV(),
      fetchKind5WithRetry: vi.fn(),
      fetchTargetEvent: vi.fn(),
      callBlossomDelete: vi.fn(),
      budgetMs: 8000
    };
  });

  function signNip98(url, method) {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', url], ['method', method]],
      content: ''
    }, sk);
    return `Nostr ${btoa(JSON.stringify(event))}`;
  }

  it('returns 200 with success on happy path', async () => {
    const kind5 = { id: KIND5_ID, pubkey: pk, tags: [['e', 't1']] };
    deps.fetchKind5WithRetry.mockResolvedValueOnce(kind5);
    deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: pk, tags: [['imeta', `x ${SHA_C}`]] });
    deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const url = `https://moderation-api.divine.video/api/delete/${KIND5_ID}`;
    const request = new Request(url, {
      method: 'POST',
      headers: { 'Authorization': signNip98(url, 'POST') }
    });

    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ kind5_id: KIND5_ID, status: 'success' });
    expect(body.targets[0]).toMatchObject({ target_event_id: 't1', status: 'success', blob_sha256: SHA_C });
  });

  it('returns 400 on malformed kind5_id', async () => {
    const url = 'https://moderation-api.divine.video/api/delete/not-a-hex-id';
    const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(400);
  });

  it('returns 401 on missing NIP-98', async () => {
    const request = new Request(`https://moderation-api.divine.video/api/delete/${KIND5_ID}`, { method: 'POST' });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(401);
  });

  it('returns 403 when caller pubkey does not match kind 5 author', async () => {
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    const kind5 = { id: KIND5_ID, pubkey: otherPk, tags: [['e', 't1']] };
    deps.fetchKind5WithRetry.mockResolvedValueOnce(kind5);

    const url = `https://moderation-api.divine.video/api/delete/${KIND5_ID}`;
    const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(403);
  });

  it('returns 404 when Funnelcake fetch returns null after retries', async () => {
    deps.fetchKind5WithRetry.mockResolvedValueOnce(null);
    const url = `https://moderation-api.divine.video/api/delete/${KIND5_ID}`;
    const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(404);
  });

  it('returns 429 when per-IP limit exceeded (before NIP-98 validation)', async () => {
    const url = `https://moderation-api.divine.video/api/delete/${KIND5_ID}`;
    // Exhaust IP limit — no NIP-98 needed since IP check runs first
    for (let i = 0; i < PER_IP_LIMIT; i++) {
      await checkRateLimit(deps.kv, { key: 'ip:1.2.3.4', limit: PER_IP_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
    }
    const request = new Request(url, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '1.2.3.4' }
    });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(429);
  });

  it('returns 429 when per-pubkey limit exceeded', async () => {
    const url = `https://moderation-api.divine.video/api/delete/${KIND5_ID}`;
    // Exhaust limit
    for (let i = 0; i < PER_PUBKEY_LIMIT; i++) {
      await checkRateLimit(deps.kv, { key: `pubkey:${pk}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
    }
    const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(429);
  });

  it('returns 202 when internal budget exceeded', async () => {
    const kind5 = { id: KIND5_ID, pubkey: pk, tags: [['e', 't1']] };
    deps.fetchKind5WithRetry.mockResolvedValueOnce(kind5);
    deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: pk, tags: [['imeta', `x ${SHA_C}`]] });
    // Blossom slow — never resolves within budget
    deps.callBlossomDelete.mockReturnValueOnce(new Promise(() => {}));

    const url = `https://moderation-api.divine.video/api/delete/${KIND5_ID}`;
    const request = new Request(url, { method: 'POST', headers: { Authorization: signNip98(url, 'POST') } });
    const response = await handleSyncDelete(request, { ...deps, budgetMs: 50 });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.status).toBe('in_progress');
  });
});
