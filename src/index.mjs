// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Main entry point for Divine video moderation worker
// ABOUTME: Consumes queue messages and processes videos for harmful content

import { validateQueueMessage } from './schemas/queue-message.mjs';
import { moderateVideo } from './moderation/pipeline.mjs';
import { publishToFaro, publishLabelEvent } from './nostr/publisher.mjs';
import { requireAuth, getAuthenticatedUser } from './admin/auth.mjs';
import { verifyZeroTrustJWT } from './admin/zerotrust.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata } from './nostr/relay-client.mjs';
import dashboardHTML from './admin/dashboard.html';
import swipeReviewHTML from './admin/swipe-review.html';

/**
 * NIP-32 label mapping for content categories
 * Maps internal category names to NIP-32/NIP-56 compatible labels
 */
const CATEGORY_TO_LABEL = {
  'nudity': { label: 'nudity', namespace: 'content-warning' },
  'violence': { label: 'violence', namespace: 'content-warning' },
  'gore': { label: 'gore', namespace: 'content-warning' },
  'offensive': { label: 'profanity', namespace: 'content-warning' },  // NIP-56 term
  'weapon': { label: 'weapons', namespace: 'content-warning' },
  'self_harm': { label: 'self-harm', namespace: 'content-warning' },
  'recreational_drug': { label: 'drugs', namespace: 'content-warning' },
  'alcohol': { label: 'alcohol', namespace: 'content-warning' },
  'tobacco': { label: 'tobacco', namespace: 'content-warning' },
  'ai_generated': { label: 'ai-generated', namespace: 'content-warning' },
  'deepfake': { label: 'deepfake', namespace: 'content-warning' },
  'medical': { label: 'medical', namespace: 'content-warning' },
  'gambling': { label: 'gambling', namespace: 'content-warning' }
};

/**
 * Generate NIP-32 style label tags based on scores and human verifications
 * @param {Object} scores - AI-generated scores for each category
 * @param {Object} categoryVerifications - Human verification status for each category
 * @returns {Array} Array of NIP-32 label tag arrays
 */
function generateNIP85Tags(scores, categoryVerifications = {}) {
  const tags = [];
  const namespaces = new Set();

  for (const [category, score] of Object.entries(scores || {})) {
    if (typeof score !== 'number' || score < 0.3) continue;

    const labelInfo = CATEGORY_TO_LABEL[category];
    if (!labelInfo) continue;

    const verification = categoryVerifications[category];

    // Only include tags that are:
    // 1. Confirmed by human, OR
    // 2. High confidence AI detection (>=0.7) and NOT rejected by human
    const isConfirmed = verification === 'confirmed';
    const isRejected = verification === 'rejected';
    const isHighConfidence = score >= 0.7;

    if (isRejected) continue;  // Human said "no, this is NOT this category"
    if (!isConfirmed && !isHighConfidence) continue;  // Low confidence and not verified

    namespaces.add(labelInfo.namespace);

    // NIP-32 format: ["l", "label", "namespace", {metadata}]
    const metadata = {
      confidence: score,
      verified: isConfirmed,
      source: isConfirmed ? 'human' : 'ai'
    };

    tags.push(['l', labelInfo.label, labelInfo.namespace, JSON.stringify(metadata)]);
  }

  // Add namespace declaration tags (L tags)
  for (const ns of namespaces) {
    tags.unshift(['L', ns]);
  }

  return tags;
}

export default {
  /**
   * HTTP handler for testing and admin dashboard
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const startTime = Date.now();
    const requestId = crypto.randomUUID().substring(0, 8);

    // Log all incoming requests
    console.log(`[${requestId}] ${request.method} ${url.pathname}${url.search ? '?' + url.search.substring(0, 100) : ''}`);

    // Admin dashboard routes
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      console.log(`[${requestId}] Redirecting to dashboard`);
      return Response.redirect(`${url.origin}/admin/dashboard`, 302);
    }

    // Login is handled by Cloudflare Zero Trust at the edge
    // Redirect any direct login requests to the dashboard (Zero Trust will prompt if needed)
    if (url.pathname === '/admin/login') {
      return Response.redirect(`${url.origin}/admin/dashboard`, 302);
    }

    // Logout via Cloudflare Access
    if (url.pathname === '/admin/logout') {
      console.log(`[${requestId}] Logout request - redirecting to CF Access logout`);
      // Cloudflare Access logout URL clears the session
      return Response.redirect(`${url.origin}/cdn-cgi/access/logout`, 302);
    }

    if (url.pathname === '/admin/dashboard') {
      // Check authentication (defense-in-depth; Zero Trust handles this at edge)
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      return new Response(dashboardHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/admin/review') {
      // Check authentication (defense-in-depth; Zero Trust handles this at edge)
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      return new Response(swipeReviewHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/admin/api/videos') {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/videos`);
        return authError;
      }

      // Parse pagination parameters
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
      const actionFilter = url.searchParams.get('action') || 'all';
      console.log(`[${requestId}] Fetching videos: filter=${actionFilter}, limit=${limit}, offset=${offset}`);

      // Build SQL query based on filter
      let whereClause = '';
      const params = [];

      if (actionFilter === 'FLAGGED') {
        whereClause = "WHERE action IN ('REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN')";
      } else if (actionFilter === 'QUARANTINE') {
        whereClause = "WHERE action IN ('AGE_RESTRICTED', 'PERMANENT_BAN')";
      } else if (actionFilter !== 'all') {
        whereClause = 'WHERE action = ?';
        params.push(actionFilter.toUpperCase());
      }

      // Query D1 with pagination
      const query = `
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at
        FROM moderation_results
        ${whereClause}
        ORDER BY moderated_at DESC
        LIMIT ? OFFSET ?
      `;
      params.push(limit + 1, offset); // Fetch one extra to check if more exist

      const result = await env.BLOSSOM_DB.prepare(query).bind(...params).all();
      const rows = result.results || [];

      // Check if there are more results
      const hasMore = rows.length > limit;
      const videos = rows.slice(0, limit).map(row => ({
        sha256: row.sha256,
        action: row.action,
        provider: row.provider,
        scores: row.scores ? JSON.parse(row.scores) : {},
        categories: row.categories ? JSON.parse(row.categories) : [],
        processedAt: new Date(row.moderated_at).getTime(),
        moderated_at: row.moderated_at,
        reviewed_by: row.reviewed_by,
        reviewed_at: row.reviewed_at
      }));

      console.log(`[${requestId}] Returning ${videos.length} videos in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify({
        videos,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + limit : null
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get real stats for dashboard
    if (url.pathname === '/admin/api/stats') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/stats`);
        return authError;
      }
      console.log(`[${requestId}] Fetching stats`);

      try {
        // All stats from D1 - fast SQL queries instead of KV iteration
        const [totalResult, moderationStats] = await Promise.all([
          // Total videos (excluding deleted/error)
          env.BLOSSOM_DB.prepare(`
            SELECT COUNT(DISTINCT sha256) as total
            FROM bunny_webhook_events
            WHERE sha256 IS NOT NULL
              AND status_name NOT IN ('error', 'deleted')
          `).first(),
          // Moderation breakdown by action
          env.BLOSSOM_DB.prepare(`
            SELECT
              action,
              COUNT(*) as count
            FROM moderation_results
            GROUP BY action
          `).all()
        ]);

        const totalInD1 = totalResult?.total || 0;

        // Parse moderation stats
        let totalModerated = 0;
        let safeCount = 0;
        let reviewCount = 0;
        let ageRestrictedCount = 0;
        let permanentBanCount = 0;

        for (const row of (moderationStats?.results || [])) {
          const count = row.count || 0;
          totalModerated += count;
          switch (row.action) {
            case 'SAFE': safeCount = count; break;
            case 'REVIEW': reviewCount = count; break;
            case 'AGE_RESTRICTED': ageRestrictedCount = count; break;
            case 'PERMANENT_BAN': permanentBanCount = count; break;
          }
        }

        const untriaged = Math.max(0, totalInD1 - totalModerated);

        console.log(`[${requestId}] Stats: total=${totalInD1}, moderated=${totalModerated}, untriaged=${untriaged}, safe=${safeCount}, review=${reviewCount} in ${Date.now() - startTime}ms`);
        return new Response(JSON.stringify({
          totalInD1,
          totalModerated,
          untriaged,
          breakdown: {
            safe: safeCount,
            review: reviewCount,
            ageRestricted: ageRestrictedCount,
            permanentBan: permanentBanCount
          }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[${requestId}] Failed to get stats:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Get untriaged (unmoderated) videos from D1
    if (url.pathname === '/admin/api/untriaged') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/untriaged`);
        return authError;
      }

      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      console.log(`[${requestId}] Fetching untriaged videos: limit=${limit}, offset=${offset}`);

      try {
        // Get recent finished videos from D1, excluding those with later deleted/error status
        // Uses subquery to get only the LATEST status for each sha256
        const result = await env.BLOSSOM_DB.prepare(`
          SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at
          FROM bunny_webhook_events e1
          WHERE sha256 IS NOT NULL
            AND received_at = (
              SELECT MAX(received_at) FROM bunny_webhook_events e2 WHERE e2.sha256 = e1.sha256
            )
            AND status_name NOT IN ('error', 'deleted')
          ORDER BY received_at DESC
          LIMIT ? OFFSET ?
        `).bind(limit, offset).all();

        // Check which ones are already moderated
        const unmoderatedRows = [];
        for (const row of result.results) {
          const existingResult = await env.MODERATION_KV.get(`moderation:${row.sha256}`);
          if (!existingResult) {
            unmoderatedRows.push(row);
          }
        }

        // Fetch Nostr context in parallel for all unmoderated videos
        const nostrPromises = unmoderatedRows.map(async (row) => {
          try {
            const event = await fetchNostrEventBySha256(row.sha256, ['wss://relay.divine.video'], env);
            if (event) {
              const metadata = parseVideoEventMetadata(event);
              return {
                sha256: row.sha256,
                title: metadata?.title || null,
                author: metadata?.author || null,
                client: metadata?.client || null,
                content: metadata?.content || event.content || null,
                pubkey: event.pubkey || null
              };
            }
          } catch (e) {
            console.error(`[ADMIN] Failed to fetch Nostr context for ${row.sha256}:`, e.message);
          }
          return { sha256: row.sha256 };
        });

        const nostrResults = await Promise.all(nostrPromises);
        const nostrMap = new Map(nostrResults.map(r => [r.sha256, r]));

        // Build videos with Nostr context
        const videos = unmoderatedRows.map(row => {
          const nostr = nostrMap.get(row.sha256) || {};
          return {
            sha256: row.sha256,
            videoGuid: row.video_guid,
            hlsUrl: row.hls_url,
            mp4Url: row.mp4_url,
            thumbnailUrl: row.thumbnail_url,
            receivedAt: row.received_at,
            status: 'UNTRIAGED',
            cdnUrl: `https://${env.CDN_DOMAIN}/${row.sha256}.mp4`,
            nostrContext: {
              title: nostr.title,
              author: nostr.author,
              client: nostr.client,
              content: nostr.content,
              pubkey: nostr.pubkey ? nostr.pubkey.substring(0, 16) + '...' : null
            }
          };
        });

        // Get total count of untriaged (same logic - latest status not deleted/error)
        const countResult = await env.BLOSSOM_DB.prepare(`
          SELECT COUNT(*) as total FROM (
            SELECT sha256
            FROM bunny_webhook_events e1
            WHERE sha256 IS NOT NULL
              AND received_at = (
                SELECT MAX(received_at) FROM bunny_webhook_events e2 WHERE e2.sha256 = e1.sha256
              )
              AND status_name NOT IN ('error', 'deleted')
          )
        `).first();

        return new Response(JSON.stringify({
          videos,
          total: countResult?.total || 0,
          offset,
          limit,
          hasMore: offset + limit < (countResult?.total || 0)
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[ADMIN] Failed to fetch untriaged videos:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Queue an untriaged video for moderation
    if (url.pathname === '/admin/api/queue-moderation' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const { sha256 } = await request.json();
      if (!sha256) {
        return new Response(JSON.stringify({ error: 'sha256 required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Queue for moderation
      await env.MODERATION_QUEUE.send({
        sha256,
        r2Key: `videos/${sha256}.mp4`,
        uploadedAt: Date.now(),
        metadata: { source: 'admin-dashboard' }
      });

      return new Response(JSON.stringify({ success: true, sha256, message: 'Queued for moderation' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update moderation action (take down, change classification, etc.)
    if (url.pathname.startsWith('/admin/api/moderate/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];
      const { action, reason, scores } = await request.json();

      // Validate action
      if (!['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(action)) {
        return new Response(JSON.stringify({ error: 'Invalid action. Must be SAFE, REVIEW, AGE_RESTRICTED, or PERMANENT_BAN' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get existing moderation result
      const existingData = await env.MODERATION_KV.get(`moderation:${sha256}`);
      if (!existingData) {
        return new Response(JSON.stringify({ error: 'Moderation result not found for this video' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existing = JSON.parse(existingData);

      // Update moderation result
      const updated = {
        ...existing,
        action,
        reason: reason || `Manual override by moderator`,
        manualOverride: true,
        overriddenBy: 'admin',
        overriddenAt: Date.now(),
        previousAction: existing.action
      };

      // If scores provided, override them
      if (scores) {
        updated.scores = {
          ...existing.scores,
          ...scores
        };
        console.log(`[ADMIN] Score override applied for ${sha256}`);
      }

      // Write updated result
      await env.MODERATION_KV.put(
        `moderation:${sha256}`,
        JSON.stringify(updated),
        {
          expirationTtl: 60 * 60 * 24 * 90 // 90 days
        }
      );

      // Update action-specific keys
      await Promise.all([
        // Clear old keys
        env.MODERATION_KV.delete(`review:${sha256}`),
        env.MODERATION_KV.delete(`age-restricted:${sha256}`),
        env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
        env.MODERATION_KV.delete(`quarantine:${sha256}`)  // Legacy
      ]);

      // Set new key based on action
      if (action === 'REVIEW') {
        await env.MODERATION_KV.put(
          `review:${sha256}`,
          JSON.stringify({
            category: updated.category,
            reason: updated.reason,
            timestamp: Date.now(),
            manualOverride: true
          })
        );
      } else if (action === 'AGE_RESTRICTED') {
        await env.MODERATION_KV.put(
          `age-restricted:${sha256}`,
          JSON.stringify({
            category: updated.category,
            reason: updated.reason,
            timestamp: Date.now(),
            manualOverride: true
          })
        );
      } else if (action === 'PERMANENT_BAN') {
        await env.MODERATION_KV.put(
          `permanent-ban:${sha256}`,
          JSON.stringify({
            category: updated.category,
            reason: updated.reason,
            timestamp: Date.now(),
            manualOverride: true
          })
        );
      }

      console.log(`[ADMIN] Updated ${sha256} from ${existing.action} to ${action}`);

      return new Response(JSON.stringify({
        success: true,
        sha256,
        action,
        previousAction: existing.action,
        message: `Content updated to ${action}`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify/reject individual category detection (for NIP-85 tagging)
    if (url.pathname.startsWith('/admin/api/verify-category/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized verify-category request`);
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];
      const { category, status } = await request.json();
      console.log(`[${requestId}] Verify category: ${sha256.substring(0, 16)}... ${category} = ${status}`);

      // Validate inputs
      const validCategories = [
        'nudity', 'violence', 'gore', 'offensive', 'weapon', 'self_harm',
        'recreational_drug', 'alcohol', 'tobacco', 'ai_generated', 'deepfake',
        'medical', 'gambling', 'money', 'destruction', 'military',
        'text_profanity', 'qr_unsafe'
      ];

      // Major flags that affect overall content action
      const majorFlags = ['nudity', 'violence', 'gore', 'ai_generated', 'deepfake', 'self_harm'];

      if (!validCategories.includes(category)) {
        return new Response(JSON.stringify({ error: `Invalid category: ${category}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (status !== null && status !== 'confirmed' && status !== 'rejected') {
        return new Response(JSON.stringify({ error: 'Status must be "confirmed", "rejected", or null' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get existing moderation result
      const existingData = await env.MODERATION_KV.get(`moderation:${sha256}`);
      if (!existingData) {
        return new Response(JSON.stringify({ error: 'Moderation result not found for this video' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existing = JSON.parse(existingData);
      const previousAction = existing.action;

      // Update category verifications
      if (!existing.categoryVerifications) {
        existing.categoryVerifications = {};
      }

      if (status === null) {
        delete existing.categoryVerifications[category];
      } else {
        existing.categoryVerifications[category] = status;
      }

      // Generate NIP-85 tags based on verifications
      existing.nip85Tags = generateNIP85Tags(existing.scores, existing.categoryVerifications);

      // Track who verified and when
      existing.lastVerifiedAt = Date.now();
      existing.lastVerifiedBy = 'admin';

      // AUTO-APPROVE LOGIC: Check if rejecting a major flag should auto-approve
      let autoApproved = false;
      if (status === 'rejected' && majorFlags.includes(category) && existing.action !== 'SAFE') {
        // Check if there are any remaining unrejected major flags with high scores
        const remainingMajorFlags = majorFlags.filter(flag => {
          const score = existing.scores?.[flag] || 0;
          const verification = existing.categoryVerifications[flag];
          // Flag is still active if: score >= 0.6 AND NOT rejected
          return score >= 0.6 && verification !== 'rejected';
        });

        console.log(`[${requestId}] Remaining major flags after rejecting ${category}:`, remainingMajorFlags);

        if (remainingMajorFlags.length === 0) {
          // No more major flags - auto-approve!
          console.log(`[${requestId}] Auto-approving ${sha256.substring(0, 16)}... - all major flags rejected`);
          existing.action = 'SAFE';
          existing.autoApprovedAt = Date.now();
          existing.autoApprovedReason = `All major flags rejected by human moderator (last: ${category})`;
          autoApproved = true;

          // Clear action-specific keys
          await Promise.all([
            env.MODERATION_KV.delete(`review:${sha256}`),
            env.MODERATION_KV.delete(`age-restricted:${sha256}`),
            env.MODERATION_KV.delete(`permanent-ban:${sha256}`)
          ]);
        }
      }

      // Write updated result
      await env.MODERATION_KV.put(
        `moderation:${sha256}`,
        JSON.stringify(existing),
        {
          expirationTtl: 60 * 60 * 24 * 90 // 90 days
        }
      );

      // PUBLISH NIP-32 LABEL EVENT (if status is confirmed or rejected)
      let labelResult = null;
      if (status === 'confirmed' || status === 'rejected') {
        const score = existing.scores?.[category] || 0;
        labelResult = await publishLabelEvent({
          sha256,
          category,
          status,
          score,
          cdnUrl: existing.cdnUrl
        }, env);
        console.log(`[${requestId}] Label publish result:`, labelResult);
      }

      console.log(`[${requestId}] Category verification complete: ${category} = ${status}, autoApproved=${autoApproved}`);

      return new Response(JSON.stringify({
        success: true,
        sha256,
        category,
        status,
        categoryVerifications: existing.categoryVerifications,
        nip85Tags: existing.nip85Tags,
        autoApproved,
        previousAction: autoApproved ? previousAction : undefined,
        newAction: autoApproved ? 'SAFE' : undefined,
        labelEvent: labelResult
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get Nostr event context for a video
    if (url.pathname.startsWith('/admin/api/nostr-context/')) {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];

      try {
        const event = await fetchNostrEventBySha256(sha256, ['wss://relay.divine.video'], env);

        if (!event) {
          return new Response(JSON.stringify({ found: false }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const metadata = parseVideoEventMetadata(event);

        return new Response(JSON.stringify({ found: true, metadata }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[ADMIN] Failed to fetch Nostr context for ${sha256}:`, error);
        return new Response(JSON.stringify({ found: false, error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Admin video proxy - bypasses quarantine check for authenticated moderators
    if (url.pathname.startsWith('/admin/video/')) {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Extract sha256 from path
      const sha256 = url.pathname.split('/')[3].replace('.mp4', '');

      console.log(`[ADMIN] Fetching video: ${sha256}`);

      // Try multiple R2 key formats (Blossom uses blobs/ prefix)
      const possibleKeys = [
        `blobs/${sha256}`,        // New SDK worker format
        `videos/${sha256}.mp4`,   // Old format
        `${sha256}.mp4`,
        sha256
      ];

      let object = null;
      let usedKey = null;

      for (const key of possibleKeys) {
        console.log(`[ADMIN] Trying R2 key: ${key}`);
        object = await env.R2_VIDEOS.get(key);
        if (object) {
          usedKey = key;
          console.log(`[ADMIN] Found video at: ${key}`);
          break;
        }
      }

      if (!object) {
        console.error(`[ADMIN] Video not found in R2: ${sha256}`);
        return new Response(JSON.stringify({
          error: 'Video not found in R2',
          sha256,
          triedKeys: possibleKeys
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`[ADMIN] Serving video from R2 key: ${usedKey}`);

      return new Response(object.body, {
        headers: {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'private, no-cache',
          'X-Admin-Bypass': 'true',
          'X-R2-Key': usedKey
        }
      });
    }

    // Test endpoint to manually trigger moderation
    if (url.pathname === '/test-moderate' && request.method === 'POST') {
      const body = await request.json();
      const { sha256 } = body;

      // Send to queue (uploadedBy is optional, omit for test)
      await env.MODERATION_QUEUE.send({
        sha256,
        r2Key: `videos/${sha256}.mp4`,
        uploadedAt: Date.now(),
        metadata: { fileSize: 1000000, contentType: 'video/mp4', duration: 6 }
      });

      return new Response(JSON.stringify({ success: true, message: 'Moderation queued', sha256 }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Test KV write
    if (url.pathname === '/test-kv') {
      try {
        await env.MODERATION_KV.put('test-key', JSON.stringify({ test: true, timestamp: Date.now() }));
        const readBack = await env.MODERATION_KV.get('test-key');
        return new Response(JSON.stringify({ success: true, written: true, readBack }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500
        });
      }
    }

    // Migration page - simple UI to run migration
    if (url.pathname === '/admin/migrate') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      return new Response(`<!DOCTYPE html>
<html><head><title>KV to D1 Migration</title></head>
<body style="font-family:monospace;padding:20px;max-width:800px;margin:0 auto">
<h1>KV to D1 Migration</h1>
<button id="start" onclick="runMigration()" style="padding:10px 20px;font-size:16px">Start Migration</button>
<pre id="log" style="background:#111;color:#0f0;padding:20px;height:400px;overflow:auto"></pre>
<script>
async function runMigration() {
  const log = document.getElementById('log');
  const btn = document.getElementById('start');
  btn.disabled = true;
  let cursor = null, total = 0, batch = 0;
  while (true) {
    batch++;
    log.textContent += 'Batch ' + batch + '...\\n';
    log.scrollTop = log.scrollHeight;
    const res = await fetch('/admin/api/migrate-kv', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cursor, batchSize: 500})
    });
    const data = await res.json();
    total += data.migrated || 0;
    log.textContent += 'Migrated ' + (data.migrated||0) + ' (total: ' + total + ')\\n';
    if (data.error) { log.textContent += 'ERROR: ' + data.error + '\\n'; break; }
    if (data.done) { log.textContent += '✅ DONE! ' + total + ' records migrated\\n'; break; }
    cursor = data.cursor;
  }
  btn.disabled = false;
}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    // Migration API endpoint - migrate KV data to D1 in batches
    if (url.pathname === '/admin/api/migrate-kv' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const body = await request.json().catch(() => ({}));
      const cursor = body.cursor || undefined;
      const batchSize = Math.min(body.batchSize || 500, 1000);

      console.log(`[MIGRATE] Starting batch migration, cursor=${cursor ? 'yes' : 'start'}, batchSize=${batchSize}`);

      try {
        // List KV keys
        const listResult = await env.MODERATION_KV.list({
          prefix: 'moderation:',
          cursor,
          limit: batchSize
        });

        const keys = listResult.keys;
        console.log(`[MIGRATE] Found ${keys.length} keys in this batch`);

        if (keys.length === 0) {
          return new Response(JSON.stringify({
            done: true,
            migrated: 0,
            message: 'Migration complete - no more keys'
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        // Fetch action flags for this batch
        const sha256List = keys.map(k => k.name.replace('moderation:', ''));
        const flagChecks = await Promise.all([
          ...sha256List.map(s => env.MODERATION_KV.get(`review:${s}`).then(v => v ? ['review', s] : null)),
          ...sha256List.map(s => env.MODERATION_KV.get(`age-restricted:${s}`).then(v => v ? ['age-restricted', s] : null)),
          ...sha256List.map(s => env.MODERATION_KV.get(`permanent-ban:${s}`).then(v => v ? ['permanent-ban', s] : null))
        ]);

        const reviewSet = new Set();
        const ageRestrictedSet = new Set();
        const permanentBanSet = new Set();

        for (const flag of flagChecks) {
          if (flag) {
            if (flag[0] === 'review') reviewSet.add(flag[1]);
            else if (flag[0] === 'age-restricted') ageRestrictedSet.add(flag[1]);
            else if (flag[0] === 'permanent-ban') permanentBanSet.add(flag[1]);
          }
        }

        // Fetch all values in parallel
        const values = await Promise.all(
          keys.map(async (k) => {
            const sha256 = k.name.replace('moderation:', '');
            const valueStr = await env.MODERATION_KV.get(k.name);
            if (!valueStr) return null;

            try {
              const value = JSON.parse(valueStr);
              let action = value.action || 'SAFE';
              if (permanentBanSet.has(sha256)) action = 'PERMANENT_BAN';
              else if (ageRestrictedSet.has(sha256)) action = 'AGE_RESTRICTED';
              else if (reviewSet.has(sha256)) action = 'REVIEW';

              return {
                sha256,
                action,
                provider: value.provider || 'sightengine',
                scores: JSON.stringify(value.scores || {}),
                categories: JSON.stringify(value.categories || []),
                raw_response: JSON.stringify(value.rawResponse || value.raw || {}),
                moderated_at: value.moderatedAt || value.timestamp || new Date().toISOString()
              };
            } catch (e) {
              console.error(`[MIGRATE] Error parsing ${sha256}:`, e.message);
              return null;
            }
          })
        );

        const validValues = values.filter(v => v !== null);

        // Batch insert into D1
        if (validValues.length > 0) {
          const stmt = env.BLOSSOM_DB.prepare(`
            INSERT OR REPLACE INTO moderation_results
            (sha256, action, provider, scores, categories, raw_response, moderated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          const batch = validValues.map(v => stmt.bind(
            v.sha256, v.action, v.provider, v.scores, v.categories, v.raw_response, v.moderated_at
          ));

          await env.BLOSSOM_DB.batch(batch);
        }

        const nextCursor = listResult.list_complete ? null : listResult.cursor;

        console.log(`[MIGRATE] Batch complete: migrated=${validValues.length}, hasMore=${!!nextCursor}`);

        return new Response(JSON.stringify({
          done: !nextCursor,
          migrated: validValues.length,
          cursor: nextCursor,
          message: nextCursor ? 'Batch complete, continue with cursor' : 'Migration complete'
        }), { headers: { 'Content-Type': 'application/json' } });

      } catch (error) {
        console.error(`[MIGRATE] Error:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Update moderation status (for external services)
    // Auth: Verify Zero Trust JWT using jose library
    if (url.pathname === '/api/v1/moderate' && request.method === 'POST') {
      const jwtToken = request.headers.get('cf-access-jwt-assertion');

      // Verify JWT signature, issuer, and audience
      const verification = await verifyZeroTrustJWT(jwtToken, env);

      if (!verification.valid) {
        console.log(`[API] JWT verification failed: ${verification.error}`);
        return new Response(JSON.stringify({
          error: `Unauthorized - ${verification.error}`
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Determine auth source for logging
      const authSource = verification.email
        ? `user:${verification.email}`
        : `service-token:${verification.payload?.sub || 'unknown'}`;

      try {
        const body = await request.json();
        const { sha256, action, reason, source } = body;

        if (!sha256 || !action) {
          return new Response(JSON.stringify({ error: 'sha256 and action required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Validate action
        const validActions = ['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
        if (!validActions.includes(action.toUpperCase())) {
          return new Response(JSON.stringify({
            error: `Invalid action. Must be one of: ${validActions.join(', ')}`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Update or insert moderation result
        await env.BLOSSOM_DB.prepare(`
          INSERT INTO moderation_results (sha256, action, provider, scores, categories, moderated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(sha256) DO UPDATE SET
            action = excluded.action,
            provider = excluded.provider,
            review_notes = ?,
            reviewed_at = ?
        `).bind(
          sha256,
          action.toUpperCase(),
          source || 'external-api',
          JSON.stringify({}),
          JSON.stringify([reason || action.toLowerCase()]),
          new Date().toISOString(),
          reason || null,
          new Date().toISOString()
        ).run();

        console.log(`[API] Moderation updated: ${sha256} -> ${action} by ${source || 'external-api'} (auth: ${authSource})`);

        return new Response(JSON.stringify({
          success: true,
          sha256,
          action: action.toUpperCase(),
          updated_at: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (error) {
        console.error('[API] Error updating moderation:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Check moderation result
    if (url.pathname.startsWith('/check-result/')) {
      const sha256 = url.pathname.split('/')[2];

      // Query D1 for moderation result
      const d1Result = await env.BLOSSOM_DB.prepare(`
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at
        FROM moderation_results
        WHERE sha256 = ?
      `).bind(sha256).first();

      if (!d1Result) {
        return new Response(JSON.stringify({
          sha256,
          status: 'unknown',
          moderated: false,
          blocked: false,
          age_restricted: false
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Simplified response for external tools
      const action = d1Result.action;
      return new Response(JSON.stringify({
        sha256,
        status: action.toLowerCase(),
        moderated: true,
        blocked: action === 'PERMANENT_BAN',
        age_restricted: action === 'AGE_RESTRICTED',
        needs_review: action === 'REVIEW',
        action,
        provider: d1Result.provider,
        scores: d1Result.scores ? JSON.parse(d1Result.scores) : null,
        categories: d1Result.categories ? JSON.parse(d1Result.categories) : null,
        moderated_at: d1Result.moderated_at,
        reviewed_by: d1Result.reviewed_by,
        reviewed_at: d1Result.reviewed_at
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Divine Moderation Service\n\nEndpoints:\nPOST /test-moderate {"sha256":"..."}\nGET  /check-result/{sha256}\nGET  /admin (password protected)', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  /**
   * Queue consumer for video moderation
   * Triggered when messages are sent to the video-moderation-queue
   */
  async queue(batch, env) {
    console.log(`[MODERATION] Processing batch of ${batch.messages.length} videos`);

    for (const message of batch.messages) {
      const startTime = Date.now();

      try {
        console.log('[MODERATION] Step 1: Validating message');

        // Validate message schema
        const validation = validateQueueMessage(message.body);
        if (!validation.valid) {
          console.error(`[MODERATION] Invalid message schema: ${validation.error}`);
          message.ack(); // Acknowledge to remove invalid message
          continue;
        }

        const { sha256, uploadedBy, uploadedAt, metadata } = validation.data;
        console.log(`[MODERATION] Step 2: Message validated for ${sha256}`);

        // Check if already moderated (duplicate prevention) - use D1
        console.log(`[MODERATION] Step 3: Checking for existing moderation result`);
        const existingResult = await env.BLOSSOM_DB.prepare(
          'SELECT sha256, action, moderated_at FROM moderation_results WHERE sha256 = ?'
        ).bind(sha256).first();

        if (existingResult) {
          console.log(`[MODERATION] ⚠️ SKIPPED ${sha256} - already moderated`);
          console.log(`[MODERATION] Previous result: action=${existingResult.action}, moderated_at=${existingResult.moderated_at}`);
          message.ack();
          continue;
        }

        console.log(`[MODERATION] Step 4: No existing result found, starting analysis for ${sha256}`);
        console.log(`[MODERATION] Blossom blob URL: https://${env.CDN_DOMAIN}/blobs/${sha256}`);

        // Run moderation pipeline
        const result = await moderateVideo({
          sha256,
          uploadedBy,
          uploadedAt,
          metadata
        }, env);

        console.log(`[MODERATION] Step 5: Analysis complete for ${sha256}`);
        console.log(`[MODERATION] Result: action=${result.action}, severity=${result.severity}`);
        console.log(`[MODERATION] Scores: nudity=${result.scores.nudity}, violence=${result.scores.violence}, ai=${result.scores.ai_generated}`);

        console.log(`[MODERATION] Step 6: Storing result in D1`);
        // Store result in D1
        await env.BLOSSOM_DB.prepare(`
          INSERT OR REPLACE INTO moderation_results
          (sha256, action, provider, scores, categories, raw_response, moderated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          sha256,
          result.action,
          result.provider || 'unknown',
          JSON.stringify(result.scores || {}),
          JSON.stringify(result.categories || []),
          JSON.stringify(result.rawResponse || {}),
          new Date().toISOString()
        ).run();
        console.log(`[MODERATION] Step 7: D1 write successful`);

        // Handle based on severity
        console.log(`[MODERATION] Step 8: Handling result (action=${result.action})`);
        await handleModerationResult(result, env);
        console.log(`[MODERATION] Step 9: Result handled`);

        // Acknowledge successful processing
        message.ack();

        console.log(`[MODERATION] ✅ COMPLETED ${sha256} in ${Date.now() - startTime}ms - ${result.action}`);

      } catch (error) {
        console.error(`[MODERATION] Error processing message:`, error);

        // Retry logic
        if (message.attempts < 3) {
          console.log(`[MODERATION] Retrying (attempt ${message.attempts + 1}/3)`);
          message.retry({ delaySeconds: Math.pow(2, message.attempts) * 10 });
        } else {
          console.error(`[MODERATION] Max retries exceeded, logging failure`);

          // Log failed moderation
          await env.MODERATION_KV.put(
            `failed:${message.body.sha256 || 'unknown'}`,
            JSON.stringify({
              error: error.message,
              stack: error.stack,
              message: message.body,
              attempts: message.attempts,
              timestamp: Date.now()
            })
          );

          message.ack(); // Acknowledge to prevent infinite retries
        }
      }
    }
  }
};

/**
 * Handle moderation result - publish notifications
 * Action is already stored in D1, this just handles notifications
 */
async function handleModerationResult(result, env) {
  const { sha256, action, scores, reason, flaggedFrames, severity, cdnUrl } = result;

  console.log(`[MODERATION] handleModerationResult called for ${sha256} with action ${action}`);

  // Publish Nostr notifications for flagged content
  if (action !== 'SAFE') {
    try {
      await publishToFaro({
        type: action.toLowerCase().replace('_', '-'),
        sha256,
        cdnUrl,
        category: result.category,
        scores,
        reason,
        severity,
        frames: flaggedFrames
      }, env);
      console.log(`[MODERATION] ${sha256} - Nostr ${action} event published`);
    } catch (error) {
      console.error(`[MODERATION] ${sha256} - Nostr publish failed:`, error);
      // Don't throw - we don't want Nostr failures to fail the whole moderation
    }
  } else {
    console.log(`[MODERATION] ${sha256} approved (no notification needed)`);
  }

  console.log(`[MODERATION] handleModerationResult finished for ${sha256}`);
}
