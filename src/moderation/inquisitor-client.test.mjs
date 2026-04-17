// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for divine-inquisitor C2PA verification client
// ABOUTME: Covers URL-mode request shape, state normalization, AI-tool detection, graceful degradation

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyC2pa, isAiToolClaimGenerator } from './inquisitor-client.mjs';

const VIDEO_URL = 'https://media.divine.video/abc123';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('verifyC2pa', () => {
  let env;

  beforeEach(() => {
    env = { INQUISITOR_BASE_URL: 'https://inquisitor.divine.video' };
  });

  it('posts URL-mode request with correct shape', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: false,
      valid: false,
      validation_state: 'unknown',
      is_proofmode: false,
      assertions: [],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://inquisitor.divine.video/verify');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ url: VIDEO_URL, mime_type: 'video/mp4' });
  });

  it('normalizes valid ProofMode response to state=valid_proofmode', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: true,
      valid: true,
      validation_state: 'valid',
      is_proofmode: true,
      claim_generator: 'ProofMode/1.1.9 Android/14',
      capture_device: 'Google Pixel 8 Pro',
      capture_time: '2024:07:22 14:33:51',
      signer: 'C=US, O=Guardian Project',
      assertions: ['stds.exif', 'org.proofmode.location'],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('valid_proofmode');
    expect(result.hasC2pa).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.isProofmode).toBe(true);
    expect(result.claimGenerator).toBe('ProofMode/1.1.9 Android/14');
    expect(result.captureDevice).toBe('Google Pixel 8 Pro');
    expect(result.captureTime).toBe('2024:07:22 14:33:51');
    expect(result.assertions).toEqual(['stds.exif', 'org.proofmode.location']);
    expect(result.error).toBeNull();
  });

  it('normalizes valid C2PA with AI-tool claim_generator to state=valid_ai_signed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: true,
      valid: true,
      validation_state: 'valid',
      is_proofmode: false,
      claim_generator: 'Adobe Firefly 2.0',
      assertions: ['c2pa.hash.data'],
      actions: [{ label: 'c2pa.created' }],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('valid_ai_signed');
    expect(result.valid).toBe(true);
    expect(result.isProofmode).toBe(false);
    expect(result.claimGenerator).toBe('Adobe Firefly 2.0');
  });

  it('matches AI-tool claim_generator case-insensitively and substring', async () => {
    const samples = [
      'DALL·E 3',
      'dall-e-3',
      'Midjourney v6',
      'Stable Diffusion XL',
      'Sora / OpenAI',
      'Runway Gen-3',
      'Ideogram 2.0',
    ];
    for (const cg of samples) {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
        has_c2pa: true,
        valid: true,
        validation_state: 'valid',
        is_proofmode: false,
        claim_generator: cg,
        assertions: [],
        actions: [],
        ingredients: [],
        verified_at: '2026-04-17T10:00:00Z',
      }));
      const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });
      expect(result.state, `claim_generator=${cg}`).toBe('valid_ai_signed');
    }
  });

  it('normalizes valid C2PA with neutral claim_generator to state=valid_c2pa', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: true,
      valid: true,
      validation_state: 'valid',
      is_proofmode: false,
      claim_generator: 'Adobe Photoshop 24.0',
      assertions: ['c2pa.hash.data'],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('valid_c2pa');
    expect(result.valid).toBe(true);
    expect(result.isProofmode).toBe(false);
  });

  it('normalizes invalid signature to state=invalid', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: true,
      valid: false,
      validation_state: 'invalid',
      is_proofmode: false,
      assertions: [],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('invalid');
    expect(result.hasC2pa).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('normalizes absent C2PA to state=absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: false,
      valid: false,
      validation_state: 'unknown',
      is_proofmode: false,
      assertions: [],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('absent');
    expect(result.hasC2pa).toBe(false);
  });

  it('returns state=unchecked on network error without throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('unchecked');
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.hasC2pa).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('returns state=unchecked on non-ok HTTP response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad gateway' }, { ok: false, status: 502 }));

    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });

    expect(result.state).toBe('unchecked');
    expect(result.error).toContain('502');
  });

  it('returns state=unchecked when INQUISITOR_BASE_URL missing', async () => {
    const fetchFn = vi.fn();
    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, {}, { fetchFn });

    expect(result.state).toBe('unchecked');
    expect(result.error).toContain('INQUISITOR_BASE_URL');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('defaults mimeType to video/mp4 when not provided', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: false,
      valid: false,
      validation_state: 'unknown',
      is_proofmode: false,
      assertions: [],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    await verifyC2pa({ url: VIDEO_URL }, env, { fetchFn });

    const [, opts] = fetchFn.mock.calls[0];
    expect(JSON.parse(opts.body).mime_type).toBe('video/mp4');
  });

  it('sets checkedAt on every result', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      has_c2pa: false,
      valid: false,
      validation_state: 'unknown',
      is_proofmode: false,
      assertions: [],
      actions: [],
      ingredients: [],
      verified_at: '2026-04-17T10:00:00Z',
    }));

    const before = new Date().toISOString();
    const result = await verifyC2pa({ url: VIDEO_URL, mimeType: 'video/mp4' }, env, { fetchFn });
    const after = new Date().toISOString();

    expect(result.checkedAt >= before).toBe(true);
    expect(result.checkedAt <= after).toBe(true);
  });
});

describe('isAiToolClaimGenerator', () => {
  it('returns true for known AI tools', () => {
    expect(isAiToolClaimGenerator('Adobe Firefly 2.0')).toBe(true);
    expect(isAiToolClaimGenerator('DALL·E 3')).toBe(true);
    expect(isAiToolClaimGenerator('dall-e-3')).toBe(true);
    expect(isAiToolClaimGenerator('Midjourney v6')).toBe(true);
    expect(isAiToolClaimGenerator('Stable Diffusion XL')).toBe(true);
    expect(isAiToolClaimGenerator('Sora / OpenAI')).toBe(true);
    expect(isAiToolClaimGenerator('Runway Gen-3')).toBe(true);
    expect(isAiToolClaimGenerator('Ideogram 2.0')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAiToolClaimGenerator('ADOBE FIREFLY')).toBe(true);
    expect(isAiToolClaimGenerator('midjourney')).toBe(true);
  });

  it('returns false for non-AI tools', () => {
    expect(isAiToolClaimGenerator('ProofMode/1.1.9 Android/14')).toBe(false);
    expect(isAiToolClaimGenerator('Adobe Photoshop 24.0')).toBe(false);
    expect(isAiToolClaimGenerator('Google Pixel 8 Pro')).toBe(false);
  });

  it('returns false for null/empty', () => {
    expect(isAiToolClaimGenerator(null)).toBe(false);
    expect(isAiToolClaimGenerator(undefined)).toBe(false);
    expect(isAiToolClaimGenerator('')).toBe(false);
  });
});
