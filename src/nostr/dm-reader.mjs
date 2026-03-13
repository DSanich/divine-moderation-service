// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-17 DM inbox reader for moderation conversations
// ABOUTME: Syncs gift-wrapped DMs from relay and stores in D1 dm_log

import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import { unwrapEvent } from 'nostr-tools/nip17';
import { computeConversationId, logDm } from './dm-store.mjs';

/**
 * Derive the moderator's hex pubkey from NOSTR_PRIVATE_KEY (hex)
 * @param {Object} env - Environment with NOSTR_PRIVATE_KEY
 * @returns {string} Hex pubkey
 */
export function getModeratorPubkey(env) {
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }
  return getPublicKey(env.NOSTR_PRIVATE_KEY);
}

/**
 * Sync the DM inbox from relay.divine.video
 * Fetches kind 1059 (gift wrap) events addressed to the moderator,
 * unwraps them, and stores in D1 dm_log table.
 *
 * @param {Object} env - Environment bindings
 * @returns {Promise<{synced: number, skipped: number, errors: number}>}
 */
export async function syncInbox(env) {
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }

  const privateKey = hexToBytes(env.NOSTR_PRIVATE_KEY);
  const moderatorPubkey = getPublicKey(privateKey);

  // Get last sync timestamp from KV
  let lastSync = null;
  if (env.MODERATION_KV) {
    const stored = await env.MODERATION_KV.get('dm-inbox:last-sync');
    if (stored) {
      lastSync = parseInt(stored, 10);
    }
  }

  // Calculate 'since' with 2-day buffer for NIP-17 randomized timestamps
  const TWO_DAYS = 2 * 86400;
  let since;
  if (lastSync) {
    since = lastSync - TWO_DAYS;
  } else {
    // First run: look back 7 days
    since = Math.floor(Date.now() / 1000) - (7 * 86400);
  }

  // Fetch gift wrap events from relay
  const relayUrl = env.RELAY_POLLING_RELAY_URL || 'wss://relay.divine.video';
  const filter = {
    kinds: [1059],
    '#p': [moderatorPubkey],
    since,
    limit: 200
  };

  console.log(`[DM-READER] Syncing inbox from ${relayUrl}, since=${new Date(since * 1000).toISOString()}`);

  const events = await fetchGiftWraps(relayUrl, filter, env);
  console.log(`[DM-READER] Fetched ${events.length} gift wrap events`);

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const giftWrap of events) {
    try {
      // Unwrap the gift wrap -> seal -> rumor
      const rumor = unwrapEvent(giftWrap, privateKey);

      if (!rumor || !rumor.content) {
        console.warn(`[DM-READER] Empty rumor from event ${giftWrap.id}`);
        errors++;
        continue;
      }

      const senderPubkey = rumor.pubkey;
      const content = rumor.content;
      const createdAt = rumor.created_at;

      // Compute conversation ID
      const conversationId = computeConversationId(moderatorPubkey, senderPubkey);

      // Check if this is a structured conversation_report
      let relatedSha256 = null;
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.type === 'conversation_report' && parsed.sha256) {
          relatedSha256 = parsed.sha256;

          // Also create entry in user_reports table if available
          if (env.BLOSSOM_DB) {
            try {
              await env.BLOSSOM_DB.prepare(`
                INSERT OR IGNORE INTO user_reports
                (sha256, reporter_pubkey, report_type, reason, created_at)
                VALUES (?, ?, ?, ?, ?)
              `).bind(
                parsed.sha256,
                senderPubkey,
                parsed.report_type || 'dm_report',
                parsed.reason || content,
                new Date(createdAt * 1000).toISOString()
              ).run();
            } catch (reportErr) {
              console.warn(`[DM-READER] Failed to insert user_report:`, reportErr.message);
            }
          }
        }
      } catch {
        // Not JSON — regular text message, that's fine
      }

      // Log to dm_log (dedup by nostr_event_id)
      const result = await logDm(env.BLOSSOM_DB, {
        conversationId,
        nostrEventId: giftWrap.id,
        senderPubkey,
        recipientPubkey: moderatorPubkey,
        content,
        direction: 'incoming',
        messageType: relatedSha256 ? 'conversation_report' : 'creator_reply',
        sha256: relatedSha256
      });

      if (result && result.id) {
        synced++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[DM-READER] Failed to process event ${giftWrap.id}:`, err.message);
      errors++;
    }
  }

  // Update last sync timestamp
  if (env.MODERATION_KV) {
    await env.MODERATION_KV.put('dm-inbox:last-sync', String(Math.floor(Date.now() / 1000)));
  }

  console.log(`[DM-READER] Sync complete: ${synced} new, ${skipped} deduped, ${errors} errors`);
  return { synced, skipped, errors };
}

/**
 * Fetch gift wrap events from relay via WebSocket
 * Uses the same pattern as relay-client.mjs: connect -> REQ -> collect -> EOSE -> close
 *
 * @param {string} relayUrl - WebSocket relay URL
 * @param {Object} filter - Nostr filter object
 * @param {Object} env - Environment with CF Access credentials
 * @returns {Promise<Array>} Array of gift wrap events
 */
function fetchGiftWraps(relayUrl, filter, env) {
  return new Promise((resolve, reject) => {
    let ws;
    const events = [];
    const timeout = setTimeout(() => {
      if (ws) ws.close();
      // Resolve with whatever we have rather than rejecting
      console.warn(`[DM-READER] WebSocket timeout, returning ${events.length} events collected so far`);
      resolve(events);
    }, 15000); // 15 second timeout for potentially many events

    try {
      const headers = {};
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }

      ws = new WebSocket(relayUrl, { headers });
      const subscriptionId = 'dm-sync-' + Math.random().toString(36).substring(7);

      ws.addEventListener('open', () => {
        const reqMessage = JSON.stringify(['REQ', subscriptionId, filter]);
        console.log(`[DM-READER] Sent REQ to ${relayUrl} with filter: kinds=[1059], since=${filter.since}, limit=${filter.limit}`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[2]) {
            events.push(data[2]);
          }

          if (data[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve(events);
          }
        } catch (err) {
          console.error('[DM-READER] Failed to parse message:', err);
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        // Resolve with whatever we collected if not already resolved
        resolve(events);
      });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}
