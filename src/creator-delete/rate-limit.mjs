// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Simple KV-backed fixed-window rate limiter for per-pubkey and per-IP limits.
// ABOUTME: Bucketed by floor(now/windowSeconds) — edge-of-bucket bursts can briefly hit 2× limit.
// ABOUTME: No cross-region atomicity either. Sufficient for abuse prevention, not exact enforcement.
// ABOUTME: Use a Durable Object if strict limits become required.

export async function checkRateLimit(kv, { key, limit, windowSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSeconds);
  const kvKey = `ratelimit:${key}:${bucket}`;
  const current = parseInt((await kv.get(kvKey)) || '0', 10);

  if (current >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds - (now % windowSeconds) };
  }

  const next = current + 1;
  await kv.put(kvKey, String(next), { expirationTtl: windowSeconds * 2 });
  return { allowed: true, remaining: limit - next };
}

