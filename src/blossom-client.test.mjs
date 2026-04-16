// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for notifyBlossom — action map, Bearer auth, return shape (success/status/networkError/skipped).
// ABOUTME: Extracted from src/index.mjs; integration tests in src/index.test.mjs continue to cover call sites.

import { describe, it, expect, vi } from 'vitest';
import { notifyBlossom } from './blossom-client.mjs';

describe('notifyBlossom (extracted)', () => {
  const baseEnv = {
    BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/api/moderate',
    BLOSSOM_WEBHOOK_SECRET: 'test-secret'
  };

  it('POSTs to BLOSSOM_WEBHOOK_URL with Bearer auth and mapped action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const env = { ...baseEnv };
    global.fetch = fetchMock;

    const result = await notifyBlossom('abc123', 'PERMANENT_BAN', env);

    expect(fetchMock).toHaveBeenCalledWith(
      baseEnv.BLOSSOM_WEBHOOK_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer test-secret' }),
        body: expect.stringContaining('"action":"PERMANENT_BAN"')
      })
    );
    expect(result).toMatchObject({ success: true });
  });

  it('maps DELETE → DELETE action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    global.fetch = fetchMock;

    await notifyBlossom('abc', 'DELETE', baseEnv);

    expect(fetchMock).toHaveBeenCalledWith(
      baseEnv.BLOSSOM_WEBHOOK_URL,
      expect.objectContaining({
        body: expect.stringContaining('"action":"DELETE"')
      })
    );
  });

  it('returns skipped when BLOSSOM_WEBHOOK_URL is not configured', async () => {
    const result = await notifyBlossom('abc', 'PERMANENT_BAN', { BLOSSOM_WEBHOOK_SECRET: 'x' });
    expect(result).toMatchObject({ success: true, skipped: true });
  });

  it('returns error with numeric status on non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('blob not found', { status: 404 }));
    const result = await notifyBlossom('abc', 'PERMANENT_BAN', baseEnv);
    expect(result).toMatchObject({ success: false, status: 404 });
    expect(result.error).toContain('404');
  });

  it('catches fetch rejection with networkError flag', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
    const result = await notifyBlossom('abc', 'PERMANENT_BAN', baseEnv);
    expect(result).toMatchObject({ success: false, networkError: true });
    expect(result.error).toContain('connection reset');
  });
});
