// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Resolves Nostr profiles (kind 0) for pubkeys via relay query.
// ABOUTME: Caches results in KV for 1 hour. Supports batch resolution.

const DIVINE_RELAY = 'wss://relay.divine.video';
const RELAY_TIMEOUT_MS = 5000;
const PROFILE_CACHE_TTL = 3600; // 1 hour

/**
 * Resolve a single Nostr profile (kind 0) for a pubkey.
 * @param {string} pubkey - Hex pubkey
 * @param {Object} env - Cloudflare Workers env (needs MODERATION_KV)
 * @returns {Promise<{name?: string, display_name?: string, picture?: string, nip05?: string} | null>}
 */
export async function resolveProfile(pubkey, env) {
  const profiles = await resolveProfiles([pubkey], env);
  return profiles[pubkey] || null;
}

/**
 * Batch resolve profiles for multiple pubkeys.
 * Checks KV cache first, queries relay for misses in one REQ.
 * @param {string[]} pubkeys - Array of hex pubkeys
 * @param {Object} env
 * @returns {Promise<Object>} Map of pubkey -> profile object
 */
export async function resolveProfiles(pubkeys, env) {
  if (!pubkeys || pubkeys.length === 0) return {};

  const results = {};
  const misses = [];

  // Check KV cache for each pubkey
  if (env.MODERATION_KV) {
    await Promise.all(pubkeys.map(async (pubkey) => {
      try {
        const cached = await env.MODERATION_KV.get(`profile:${pubkey}`);
        if (cached !== null) {
          const parsed = JSON.parse(cached);
          // Empty object means "no profile found" (negative cache)
          if (Object.keys(parsed).length > 0) {
            results[pubkey] = parsed;
          }
        } else {
          misses.push(pubkey);
        }
      } catch {
        misses.push(pubkey);
      }
    }));
  } else {
    misses.push(...pubkeys);
  }

  if (misses.length === 0) return results;

  // Query relay for all misses in one REQ
  try {
    const profiles = await queryProfiles(misses, env);

    // Cache results (including negative caches for misses)
    for (const pubkey of misses) {
      const profile = profiles[pubkey] || null;
      if (profile) {
        results[pubkey] = profile;
      }

      // Cache in KV (cache nulls as empty object to avoid re-querying)
      if (env.MODERATION_KV) {
        try {
          await env.MODERATION_KV.put(
            `profile:${pubkey}`,
            JSON.stringify(profile || {}),
            { expirationTtl: PROFILE_CACHE_TTL }
          );
        } catch (err) {
          console.error('[PROFILE] Failed to cache profile:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[PROFILE] Failed to query profiles from relay:', err.message);
  }

  return results;
}

/**
 * Query relay for kind 0 profiles for multiple pubkeys.
 * @param {string[]} pubkeys
 * @param {Object} env
 * @returns {Promise<Object>} Map of pubkey -> {name, display_name, picture, nip05}
 */
async function queryProfiles(pubkeys, env) {
  return new Promise((resolve) => {
    let ws;
    const profiles = {};
    const timeout = setTimeout(() => {
      if (ws) {
        try { ws.close(); } catch (_) { /* ignore */ }
      }
      resolve(profiles);
    }, RELAY_TIMEOUT_MS);

    try {
      // Cloudflare Workers' WebSocket constructor only accepts a subprotocol
      // string/array as the second argument; passing an options object fails
      // with "The protocol header token is invalid" and silently breaks
      // profile resolution. relay.divine.video is a public Nostr relay that
      // does not require CF Access, so we don't need to forward those
      // headers here. Same fix as dm-reader.mjs and relay-client.mjs.
      ws = new WebSocket(DIVINE_RELAY);

      ws.addEventListener('open', () => {
        const filter = { kinds: [0], authors: pubkeys, limit: pubkeys.length };
        const subId = 'profile-' + Date.now().toString(36);
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg[0] === 'EVENT') {
            const nostrEvent = msg[2];
            if (nostrEvent && nostrEvent.kind === 0 && nostrEvent.pubkey) {
              try {
                const content = JSON.parse(nostrEvent.content);
                profiles[nostrEvent.pubkey] = {
                  name: content.name || null,
                  display_name: content.display_name || content.displayName || null,
                  picture: content.picture || null,
                  nip05: content.nip05 || null,
                };
              } catch {
                // Invalid JSON in profile content
              }
            }
          }

          if (msg[0] === 'EOSE') {
            clearTimeout(timeout);
            try { ws.close(); } catch (_) { /* ignore */ }
            resolve(profiles);
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        resolve(profiles);
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        resolve(profiles);
      });
    } catch (err) {
      clearTimeout(timeout);
      console.error('[PROFILE] WebSocket error:', err.message);
      resolve(profiles);
    }
  });
}
