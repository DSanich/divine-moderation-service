// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Pure validation and parsing helpers extracted from index.mjs
// ABOUTME: Provides SHA-256, pubkey, identifier validation and media event parsing

export function isValidSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function isValidLookupIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

export function isValidPubkey(value) {
  return isValidSha256(value);
}

export function parseMaybeJson(value, fallback) {
  if (value == null) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  return value;
}

export function getEventTagValue(tags, key) {
  return tags?.find((tag) => tag[0] === key)?.[1] || null;
}

export function parseImetaParams(tags) {
  const imetaTag = tags?.find((tag) => tag[0] === 'imeta');
  if (!imetaTag) {
    return {};
  }

  const params = {};
  for (let i = 1; i < imetaTag.length; i++) {
    const entry = imetaTag[i];
    if (!entry || typeof entry !== 'string') {
      continue;
    }

    const separatorIndex = entry.indexOf(' ');
    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1).trim();
    if (key && value) {
      params[key] = value;
    }
  }

  return params;
}

export function extractShaFromUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }

  const match = url.match(/[0-9a-f]{64}/i);
  return match ? match[0].toLowerCase() : null;
}

export function extractMediaShaFromEvent(event) {
  const tags = event?.tags || [];
  const imeta = parseImetaParams(tags);
  return extractShaFromUrl(imeta.x)
    || extractShaFromUrl(getEventTagValue(tags, 'x'))
    || extractShaFromUrl(imeta.url)
    || extractShaFromUrl(getEventTagValue(tags, 'url'))
    || null;
}
