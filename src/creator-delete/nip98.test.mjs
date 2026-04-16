// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for NIP-98 validator — happy path + rejection paths (missing, wrong kind, expired, mismatched, tampered).
// ABOUTME: Uses nostr-tools to sign test fixtures with ephemeral keys.

import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { validateNip98Header } from './nip98.mjs';

describe('validateNip98Header', () => {
  let sk, pk;

  beforeEach(() => {
    sk = generateSecretKey();
    pk = getPublicKey(sk);
  });

  function signNip98(url, method, skOverride) {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', url], ['method', method]],
      content: ''
    }, skOverride || sk);
    const encoded = btoa(JSON.stringify(event));
    return `Nostr ${encoded}`;
  }

  it('accepts a valid signature for matching url and method', async () => {
    const header = signNip98('https://moderation-api.divine.video/api/delete/abc123', 'POST');
    const result = await validateNip98Header(header, 'https://moderation-api.divine.video/api/delete/abc123', 'POST');
    expect(result.valid).toBe(true);
    expect(result.pubkey).toBe(pk);
  });

  it('rejects missing Authorization header', async () => {
    const result = await validateNip98Header(undefined, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing or malformed/);
  });

  it('rejects non-Nostr scheme', async () => {
    const result = await validateNip98Header('Bearer abc', 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
  });

  it('rejects wrong kind', async () => {
    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Expected kind 27235/);
  });

  it('rejects expired created_at (outside ±60s)', async () => {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - 120,
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/outside/);
  });

  it('rejects mismatched url', async () => {
    const header = signNip98('https://x/different', 'POST');
    const result = await validateNip98Header(header, 'https://x/expected', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/u tag/);
  });

  it('rejects mismatched method', async () => {
    const header = signNip98('https://x/y', 'GET');
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/method tag/);
  });

  it('rejects tampered signature', async () => {
    const realEvent = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    realEvent.sig = realEvent.sig.slice(0, -4) + '0000';
    const header = `Nostr ${btoa(JSON.stringify(realEvent))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature/);
  });
});
