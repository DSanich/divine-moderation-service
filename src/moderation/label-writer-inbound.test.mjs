import { describe, it, expect, vi } from 'vitest';
import { writeInboundAtprotoLabel } from './label-writer.mjs';

describe('writeInboundAtprotoLabel', () => {
  it('writes to ClickHouse with external-labeler source type', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const env = {
      CLICKHOUSE_URL: 'http://clickhouse:8123',
      CLICKHOUSE_PASSWORD: 'test',
    };

    await writeInboundAtprotoLabel('abc123sha256', {
      labeler_did: 'did:plc:ozone-mod',
      val: 'nudity',
      neg: false,
    }, env);

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = mockFetch.mock.calls[0][1].body;
    const row = JSON.parse(body);
    expect(row.sha256).toBe('abc123sha256');
    expect(row.label).toBe('nudity');
    expect(row.source_id).toBe('did:plc:ozone-mod');
    expect(row.source_type).toBe('external-labeler');
    expect(row.transport).toBe('atproto-firehose');
  });

  it('skips if no ClickHouse config', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    await writeInboundAtprotoLabel('abc', { labeler_did: 'x', val: 'y', neg: false }, {});
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
