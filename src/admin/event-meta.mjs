// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared helpers that render uploader identity + Nostr event
// ABOUTME: links for the admin dashboard and Quick Review pages.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function firstPresent(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

export function buildDivineVideoUrl(video) {
  if (!video) return null;
  const direct = firstPresent(video.divineUrl);
  if (direct) return direct;
  const eid = firstPresent(video.eventId, video.event_id, video?.nostrContext?.eventId);
  return eid ? `https://divine.video/video/${eid}` : null;
}

export function buildProfileUrl(pubkey) {
  if (!pubkey) return null;
  const str = String(pubkey).trim();
  if (!str) return null;
  return `https://divine.video/profile/${str}`;
}

export function truncatePubkey(pubkey) {
  if (!pubkey) return '';
  const str = String(pubkey);
  if (str.length <= 16) return str;
  return `${str.slice(0, 8)}...${str.slice(-8)}`;
}

export function pickAuthorName(video) {
  if (!video) return 'Unknown publisher';
  const ctx = video.nostrContext || {};
  return firstPresent(video.author, ctx.author, ctx.displayName) || 'Unknown publisher';
}

function pickPubkey(video) {
  if (!video) return null;
  const ctx = video.nostrContext || {};
  const raw = firstPresent(video.uploaded_by, video.uploadedBy, ctx.pubkey);
  if (!raw) return null;
  const str = String(raw);
  // The swipe-review API occasionally stores a pre-truncated pubkey like
  // "aabbccdd...". We keep the raw value for display but don't use it to
  // build a profile link (which needs a full 64-hex pubkey).
  return str;
}

function isFullHexPubkey(pubkey) {
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey);
}

function formatTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let date;
  if (typeof value === 'number') {
    // Seconds vs. milliseconds heuristic (Nostr published_at is seconds)
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

/**
 * Renders the uploader identity block: avatar initial, author name,
 * truncated pubkey (copyable via data attribute), profile link, and
 * Nostr event link. Used at the top of moderation cards.
 */
export function createEventMetaHTML(video = {}) {
  const authorName = pickAuthorName(video);
  const pubkey = pickPubkey(video);
  const profileUrl = isFullHexPubkey(pubkey) ? buildProfileUrl(pubkey) : null;
  const divineUrl = buildDivineVideoUrl(video);
  const eventId = firstPresent(video.eventId, video.event_id, video?.nostrContext?.eventId);
  const publishedAt = formatTimestamp(
    firstPresent(video.published_at, video.publishedAt, video?.nostrContext?.publishedAt)
  );
  const avatarChar = (authorName || '?').trim().charAt(0).toUpperCase() || '?';

  const pubkeyLine = pubkey
    ? `<span class="event-meta-pubkey" title="${escapeHtml(pubkey)}" data-pubkey="${escapeHtml(pubkey)}">${escapeHtml(truncatePubkey(pubkey))}</span>`
    : '<span class="event-meta-pubkey empty">No pubkey</span>';

  const links = [];
  if (profileUrl) {
    links.push(
      `<a class="event-meta-link" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener noreferrer">Profile</a>`
    );
  }
  if (divineUrl) {
    links.push(
      `<a class="event-meta-link" href="${escapeHtml(divineUrl)}" target="_blank" rel="noopener noreferrer">Nostr event</a>`
    );
  }

  const linksHtml = links.length
    ? `<div class="event-meta-links">${links.join('')}</div>`
    : '';

  const publishedHtml = publishedAt
    ? `<div class="event-meta-published"><span class="event-meta-label">Published</span> ${escapeHtml(publishedAt)}</div>`
    : '';

  const eventIdHtml = eventId
    ? `<div class="event-meta-event-id"><span class="event-meta-label">Event</span> <code>${escapeHtml(truncatePubkey(eventId))}</code></div>`
    : '';

  return `
    <div class="event-meta">
      <div class="event-meta-avatar" aria-hidden="true">${escapeHtml(avatarChar)}</div>
      <div class="event-meta-body">
        <div class="event-meta-name">${escapeHtml(authorName)}</div>
        <div class="event-meta-pubkey-row">${pubkeyLine}</div>
        ${eventIdHtml}
        ${publishedHtml}
        ${linksHtml}
      </div>
    </div>
  `;
}
