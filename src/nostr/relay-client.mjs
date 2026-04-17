// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Nostr relay WebSocket client for fetching event context
// ABOUTME: Connects to relay.divine.video to get kind 34236 video events by SHA256

async function queryRelay(relayUrl, filter, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let subscriptionId = null;
    const collectAll = Boolean(options.collectAll);
    const events = [];
    let firstEvent = null;
    const timeout = setTimeout(() => {
      try {
        if (ws) ws.close();
      } catch {}
      finish(new Error('WebSocket timeout'));
    }, 5000); // 5 second timeout - should be fast with direct query

    function finish(resultOrError) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (resultOrError instanceof Error) {
        reject(resultOrError);
        return;
      }

      resolve(resultOrError);
    }

    try {
      // Build WebSocket URL with Cloudflare Access headers
      const headers = {};
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }

      ws = new WebSocket(relayUrl, { headers });

      ws.addEventListener('open', () => {
        subscriptionId = Math.random().toString(36).substring(7);
        const reqMessage = JSON.stringify([
          'REQ',
          subscriptionId,
          filter
        ]);

        console.log(`[NOSTR] Querying ${relayUrl}: ${JSON.stringify(filter)}`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[1] === subscriptionId) {
            const event = data[2];
            if (collectAll) {
              if (event?.id && !events.some((existing) => existing.id === event.id)) {
                events.push(event);
              }
            } else if (!firstEvent) {
              firstEvent = event;
              try {
                ws.close();
              } catch {}
              finish(event);
            }
          }

          if (data[0] === 'EOSE' && data[1] === subscriptionId) {
            try {
              ws.close();
            } catch {}
            finish(collectAll ? events : firstEvent);
          }
        } catch (err) {
          console.error('[NOSTR] Failed to parse message:', err);
        }
      });

      ws.addEventListener('error', (err) => {
        finish(err instanceof Error ? err : new Error('WebSocket error'));
      });

      ws.addEventListener('close', () => {
        finish(collectAll ? events : firstEvent);
      });

    } catch (error) {
      finish(error instanceof Error ? error : new Error('WebSocket setup failed'));
    }
  });
}

/**
 * Fetch Nostr event for a video SHA256 from relay.
 * The d-tag in kind 34236 video events contains the SHA256 hash directly.
 *
 * @param {string} sha256 - Video hash
 * @param {string[]} relays - Relay URLs to query
 * @param {Object} env - Environment variables (for Cloudflare Access tokens)
 * @returns {Promise<Object|null>} Nostr event or null if not found
 */
export async function fetchNostrEventBySha256(sha256, relays = ['wss://relay.divine.video'], env = {}) {
  for (const relay of relays) {
    try {
      const event = await queryRelay(relay, {
        kinds: [34236],
        '#d': [sha256],
        limit: 1
      }, env);
      if (event) {
        return event;
      }
    } catch (error) {
      console.error(`[NOSTR] Failed to fetch from ${relay}:`, error);
    }
  }

  return null;
}

/**
 * Fetch all addressable video event versions for a d-tag / SHA256.
 *
 * @param {string} dTag - Addressable event d-tag, which for Divine videos is the media SHA256
 * @param {string[]} relays - Relay URLs to query
 * @param {Object} env - Environment variables (for Cloudflare Access tokens)
 * @param {Object} options - Query options
 * @returns {Promise<Object[]>} Matching video events
 */
export async function fetchNostrVideoEventsByDTag(dTag, relays = ['wss://relay.divine.video'], env = {}, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;

  for (const relay of relays) {
    try {
      const events = await queryRelay(relay, {
        kinds: [34235, 34236],
        '#d': [dTag],
        limit
      }, env, { collectAll: true });
      if (events.length > 0) {
        return events;
      }
    } catch (error) {
      console.error(`[NOSTR] Failed to fetch versions from ${relay}:`, error);
    }
  }

  return [];
}

/**
 * Extract SHA256 from imeta tag parameters
 * imeta format: ["imeta", "url ...", "m video/mp4", "x <sha256>", "image ..."]
 */
function extractSha256FromImeta(event) {
  if (!event || !event.tags) return null;

  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      // Parse space-separated parameters in imeta tag
      for (let i = 1; i < tag.length; i++) {
        const param = tag[i];
        // Look for "x <sha256>" parameter
        if (param && param.startsWith('x ')) {
          return param.substring(2).trim();
        }
      }
    }
  }

  return null;
}

/**
 * Extract metadata from kind 34236 event tags
 */
export function parseVideoEventMetadata(event) {
  if (!event || !event.tags) {
    return null;
  }

  const metadata = {
    title: null,
    author: null,
    summary: null,
    platform: null,
    client: null,
    loops: null,
    likes: null,
    comments: null,
    url: null,
    sourceUrl: null,
    publishedAt: null,
    archivedAt: null,
    importedAt: null,
    vineHashId: null,
    vineUserId: null,
    proofmode: null,
    stableId: null
  };

  for (const tag of event.tags) {
    const [key, value] = tag;

    switch (key) {
      case 'title':
        metadata.title = value;
        break;
      case 'author':
        metadata.author = value;
        break;
      case 'summary':
        metadata.summary = value;
        break;
      case 'platform':
        metadata.platform = value;
        break;
      case 'client':
        metadata.client = value;
        break;
      case 'loops':
        metadata.loops = parseInt(value, 10);
        break;
      case 'likes':
        metadata.likes = parseInt(value, 10);
        break;
      case 'comments':
        metadata.comments = parseInt(value, 10);
        break;
      case 'r':
        // Store original source URL (e.g., vine.co URL)
        metadata.sourceUrl = value;
        // Only use 'r' tag URL if we don't already have one from imeta
        if (!metadata.url) {
          metadata.url = value;
        }
        break;
      case 'published_at':
        metadata.publishedAt = parseInt(value, 10);
        break;
      case 'archived_at':
        metadata.archivedAt = value;
        break;
      case 'imported_at':
        metadata.importedAt = parseInt(value, 10);
        break;
      case 'vine_hash_id':
        metadata.vineHashId = value;
        break;
      case 'vine_user_id':
        metadata.vineUserId = value;
        break;
      case 'proofmode': {
        const proofmode = {
          createdAt: null,
          device: null,
          proof: null,
          raw: tag.slice(1)
        };

        for (let i = 1; i < tag.length; i++) {
          const entry = tag[i];
          if (!entry || typeof entry !== 'string') {
            continue;
          }

          if (entry.startsWith('created_at ')) {
            const parsed = parseInt(entry.substring('created_at '.length), 10);
            proofmode.createdAt = Number.isNaN(parsed) ? null : parsed;
          } else if (entry.startsWith('device ')) {
            proofmode.device = entry.substring('device '.length).trim() || null;
          } else if (entry.startsWith('proof ')) {
            proofmode.proof = entry.substring('proof '.length).trim() || null;
          }
        }

        metadata.proofmode = proofmode;
        break;
      }
      case 'd':
        metadata.stableId = value;
        break;
      case 'imeta':
        // Extract URL from imeta tag - format: "url https://..."
        // Blossom URLs use content-addressed hashes without file extensions
        for (let i = 1; i < tag.length; i++) {
          const param = tag[i];
          if (param && param.startsWith('url ') && param.length > 4) {
            metadata.url = param.substring(4).trim();
            break;
          }
        }
        break;
    }
  }

  metadata.content = event.content || metadata.summary;
  metadata.eventId = event.id;
  metadata.createdAt = event.created_at;

  return metadata;
}

/**
 * Check if a video is an original Vine (should skip AI detection)
 * Original Vines are from 2013-2017 and predate AI video generation
 */
export function isOriginalVine(nostrContext) {
  if (!nostrContext) return false;

  if (hasStrongOriginalVineEvidence(nostrContext)) return true;

  // Check if published_at is before 2018 (Vine shut down Jan 2017)
  // Timestamp 1514764800 = Jan 1, 2018
  if (nostrContext.publishedAt && nostrContext.publishedAt < 1514764800) return true;

  return false;
}

export function hasStrongOriginalVineEvidence(nostrContext) {
  if (!nostrContext) return false;

  // Direct indicators of original Vine content
  if (nostrContext.platform === 'vine') return true;
  if (nostrContext.client && /vine-(archive-importer|archaeologist)/.test(nostrContext.client)) return true;
  if (nostrContext.vineHashId) return true;
  if (nostrContext.sourceUrl && nostrContext.sourceUrl.includes('vine.co')) return true;

  return false;
}

export async function fetchKind5EventsSince(sinceSeconds, relayUrl = 'wss://relay.divine.video', env = {}) {
  return queryRelay(relayUrl, { kinds: [5], since: sinceSeconds }, env, { collectAll: true });
}

export async function fetchNostrEventById(eventId, relays = ['wss://relay.divine.video'], env = {}) {
  // Reject non-hex IDs to prevent path-traversal via attacker-controlled kind 5 e-tags
  if (!eventId || !/^[a-f0-9]{64}$/i.test(eventId)) return null;

  for (const relayUrl of relays) {
    // Use Funnelcake's REST API (GET /api/event/{id}) instead of WebSocket REQ.
    // Faster (no upgrade handshake), works in local dev (Miniflare), and the
    // endpoint returns a raw Nostr event: { id, pubkey, created_at, kind, tags, content, sig }.
    const apiBaseUrl = relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
    try {
      const headers = { 'Accept': 'application/json' };
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }
      const response = await fetch(`${apiBaseUrl}/api/event/${eventId}`, { headers });
      if (!response.ok) continue;
      const event = await response.json();
      if (event?.id && event?.pubkey) return event;
    } catch {
      continue;
    }
  }
  return null;
}
