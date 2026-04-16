// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: POST /api/delete/{kind5_id} — synchronous creator-delete handler.
// ABOUTME: NIP-98 author-only auth; fetches kind 5 with read-after-write retries; runs processKind5 within budget.

import { validateNip98Header } from './nip98.mjs';
import { processKind5 } from './process.mjs';
import { checkRateLimit } from './rate-limit.mjs';

export const PER_PUBKEY_LIMIT = 5;
export const PER_IP_LIMIT = 30;
export const RATE_WINDOW_SECONDS = 60;

export async function handleSyncDelete(request, deps) {
  const t0 = Date.now();
  const { db, kv, fetchKind5WithRetry, fetchTargetEvent, callBlossomDelete, budgetMs = 8000 } = deps;

  const url = new URL(request.url);
  const kind5_id = url.pathname.split('/').pop();

  if (!kind5_id || !/^[a-f0-9]{64}$/i.test(kind5_id)) {
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 400,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(400, { error: 'Invalid kind5_id' });
  }

  const auth = await validateNip98Header(request.headers.get('Authorization'), url.toString(), 'POST');
  if (!auth.valid) {
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 401,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(401, { error: `NIP-98 validation failed: ${auth.error}` });
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipCheck = await checkRateLimit(kv, { key: `ip:${clientIp}`, limit: PER_IP_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
  const pubkeyCheck = await checkRateLimit(kv, { key: `pubkey:${auth.pubkey}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
  if (!ipCheck.allowed || !pubkeyCheck.allowed) {
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 429,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(429, {
      error: 'Rate limit exceeded',
      retry_after_seconds: Math.max(ipCheck.retryAfterSeconds || 0, pubkeyCheck.retryAfterSeconds || 0)
    });
  }

  const kind5 = await fetchKind5WithRetry(kind5_id);
  if (!kind5) {
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 404,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(404, { error: 'Kind 5 not found on Funnelcake after retries' });
  }

  if (kind5.pubkey !== auth.pubkey) {
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 403,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(403, { error: 'Caller pubkey does not match kind 5 author' });
  }

  const deadline = Date.now() + budgetMs;
  const processing = processKind5(kind5, {
    db,
    fetchTargetEvent,
    callBlossomDelete,
    triggerLabel: 'sync'
  });

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ budgetExceeded: true }), budgetMs));
  const raceResult = await Promise.race([processing, timeoutPromise]);

  if (raceResult.budgetExceeded) {
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 202,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(202, {
      kind5_id,
      status: 'in_progress',
      poll_url: `/api/delete-status/${kind5_id}`
    });
  }

  const anyFailed = raceResult.targets.some(t => t.status.startsWith('failed:'));
  const anyInProgress = raceResult.targets.some(t => t.status === 'in_progress');

  if (anyInProgress && Date.now() < deadline) {
    // One target still had an in-progress existing row. Return 202.
    console.log(JSON.stringify({
      event: 'creator_delete.sync.request',
      status_code: 202,
      latency_ms: Date.now() - t0,
      kind5_id: kind5_id || null
    }));
    return jsonResponse(202, {
      kind5_id,
      status: 'in_progress',
      poll_url: `/api/delete-status/${kind5_id}`
    });
  }

  console.log(JSON.stringify({
    event: 'creator_delete.sync.request',
    status_code: 200,
    latency_ms: Date.now() - t0,
    kind5_id: kind5_id || null
  }));
  return jsonResponse(200, {
    kind5_id,
    status: anyFailed ? 'failed' : 'success',
    targets: raceResult.targets
  });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
