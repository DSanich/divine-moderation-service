// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for ClickHouse moderation label writer
// ABOUTME: Verifies skip conditions, threshold filtering, normalization, source metadata, and error handling

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeModerationLabels } from './label-writer.mjs';

describe('writeModerationLabels', () => {
  let mockEnv;
  let fetchSpy;

  beforeEach(() => {
    mockEnv = {
      CLICKHOUSE_URL: 'https://clickhouse.example.com:8443',
      CLICKHOUSE_PASSWORD: 'test-password',
      CLICKHOUSE_USER: 'default',
    };

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('should skip when CLICKHOUSE_URL is not configured', async () => {
    delete mockEnv.CLICKHOUSE_URL;
    await writeModerationLabels('abc123', { action: 'QUARANTINE', scores: { nudity: 0.9 } }, mockEnv);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should skip when CLICKHOUSE_PASSWORD is not configured', async () => {
    delete mockEnv.CLICKHOUSE_PASSWORD;
    await writeModerationLabels('abc123', { action: 'QUARANTINE', scores: { nudity: 0.9 } }, mockEnv);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should skip when scores are empty', async () => {
    await writeModerationLabels('abc123', { action: 'SAFE', scores: {} }, mockEnv);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should skip when scores are undefined', async () => {
    await writeModerationLabels('abc123', { action: 'SAFE' }, mockEnv);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should filter out scores below 0.5 threshold', async () => {
    await writeModerationLabels('abc123', {
      action: 'SAFE',
      scores: { nudity: 0.3, violence: 0.1 },
    }, mockEnv);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should write labels for scores at or above 0.5', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9, violence: 0.3 },
    }, mockEnv);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('clickhouse.example.com');
    expect(opts.method).toBe('POST');

    const body = opts.body;
    const rows = body.split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('nudity');
    expect(rows[0].sha256).toBe('abc123');
    expect(rows[0].confidence).toBe(0.9);
  });

  it('should normalize labels via classifierCategoryToLabels', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { gore: 0.8, weapon: 0.7 },
    }, mockEnv);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchSpy.mock.calls[0][1].body;
    const rows = body.split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(2);

    const labels = rows.map(r => r.label);
    expect(labels).toContain('graphic-media');
    expect(labels).toContain('violence');
  });

  it('should use provided source metadata', async () => {
    await writeModerationLabels('abc123', {
      action: 'AGE_RESTRICTED',
      scores: { nudity: 0.95 },
    }, mockEnv, {
      sourceId: 'blacksky-v1',
      sourceOwner: 'partner',
      sourceType: 'machine-labeler',
      transport: 'partner-api',
    });

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.source_id).toBe('blacksky-v1');
    expect(row.source_owner).toBe('partner');
    expect(row.source_type).toBe('machine-labeler');
    expect(row.transport).toBe('partner-api');
  });

  it('should default source metadata when not provided', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.8 },
      provider: 'divine-hive',
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.source_id).toBe('divine-hive');
    expect(row.source_owner).toBe('divine');
    expect(row.source_type).toBe('machine-labeler');
    expect(row.transport).toBe('moderation-api');
  });

  it('should set review_state to human-confirmed when reviewed_by is present', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9 },
      reviewed_by: 'moderator@example.com',
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.review_state).toBe('human-confirmed');
  });

  it('should set review_state to automated when reviewed_by is not present', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9 },
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.review_state).toBe('automated');
  });

  it('should default operation to apply', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9 },
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.operation).toBe('apply');
  });

  it('should support clear operation via source metadata', async () => {
    await writeModerationLabels('abc123', {
      action: 'SAFE',
      scores: { nudity: 0.9 },
    }, mockEnv, {
      operation: 'clear',
    });

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.operation).toBe('clear');
  });

  it('should include updated_at timestamp in each row', async () => {
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9 },
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.updated_at).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at);
  });

  it('should handle ClickHouse errors gracefully without throwing', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9 },
    }, mockEnv);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LABELS] ClickHouse write failed:'),
      500,
      'Internal Server Error'
    );
    consoleSpy.mockRestore();
  });

  it('should handle fetch network errors gracefully without throwing', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await writeModerationLabels('abc123', {
      action: 'QUARANTINE',
      scores: { nudity: 0.9 },
    }, mockEnv);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LABELS] ClickHouse write error:'),
      'Network error'
    );
    consoleSpy.mockRestore();
  });

  it('should include action in each row', async () => {
    await writeModerationLabels('abc123', {
      action: 'PERMANENT_BAN',
      scores: { nudity: 0.99 },
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.action).toBe('PERMANENT_BAN');
  });

  it('should prefer downstream signal scores over raw scores when provided', async () => {
    await writeModerationLabels('abc123', {
      action: 'SAFE',
      scores: { nudity: 0.9, ai_generated: 0.97 },
      downstreamSignals: {
        hasSignals: true,
        scores: { nudity: 0.9, ai_generated: 0 }
      }
    }, mockEnv);

    const body = fetchSpy.mock.calls[0][1].body;
    const rows = body.split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('nudity');
  });
});
