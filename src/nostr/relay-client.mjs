// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Nostr relay WebSocket client for fetching event context
// ABOUTME: Connects to relay.divine.video to get kind 34236 video events by SHA256

/**
 * Fetch Nostr event for a video SHA256 from relay
 * @param {string} sha256 - Video hash
 * @param {string[]} relays - Relay URLs to query
 * @param {Object} env - Environment variables (for Cloudflare Access tokens)
 * @returns {Promise<Object|null>} Nostr event or null if not found
 */
export async function fetchNostrEventBySha256(sha256, relays = ['wss://relay.divine.video'], env = {}) {
  for (const relay of relays) {
    try {
      const event = await fetchFromRelay(relay, sha256, env);
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
 * Connect to a single relay and query for event using efficient #d tag filter
 * The 'd' tag in kind 34236 events contains the SHA256 hash directly
 */
async function fetchFromRelay(relayUrl, sha256, env = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    const timeout = setTimeout(() => {
      if (ws) ws.close();
      reject(new Error('WebSocket timeout'));
    }, 5000); // 5 second timeout - should be fast with direct query

    try {
      // Build WebSocket URL with Cloudflare Access headers
      const headers = {};
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }

      ws = new WebSocket(relayUrl, { headers });
      let foundEvent = null;

      ws.addEventListener('open', () => {
        // Query directly by #d tag (the SHA256 hash) - much faster than fetching all events
        const subscriptionId = Math.random().toString(36).substring(7);
        const reqMessage = JSON.stringify([
          'REQ',
          subscriptionId,
          {
            kinds: [34236],
            '#d': [sha256],
            limit: 1
          }
        ]);

        console.log(`[NOSTR] Querying ${relayUrl} by #d tag for SHA256: ${sha256.substring(0, 16)}...`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          // Check if this is an EVENT message
          if (data[0] === 'EVENT' && !foundEvent) {
            const event = data[2];
            console.log(`[NOSTR] Found event for SHA256: ${sha256.substring(0, 16)}...`);
            foundEvent = event;
            clearTimeout(timeout);
            ws.close();
            resolve(event);
          }

          // Check if this is an EOSE (end of stored events)
          if (data[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            if (!foundEvent) {
              console.log(`[NOSTR] No event found for SHA256: ${sha256.substring(0, 16)}...`);
              resolve(null);
            }
          }
        } catch (err) {
          console.error('[NOSTR] Failed to parse message:', err);
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!foundEvent) {
          resolve(null);
        }
      });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
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
    vineUserId: null
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

  metadata.content = event.content;
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
  if (nostrContext.client === 'vine-archaeologist') return true;
  if (nostrContext.vineHashId) return true;
  if (nostrContext.sourceUrl && nostrContext.sourceUrl.includes('vine.co')) return true;

  return false;
}
