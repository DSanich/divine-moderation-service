import { describe, it, expect } from 'vitest';
import { buildNostrLabelFromAtproto } from './inbound-publisher.mjs';

describe('buildNostrLabelFromAtproto', () => {
  it('maps nudity label to NIP-32 publish params', () => {
    const result = buildNostrLabelFromAtproto({
      val: 'nudity',
      neg: false,
      sha256: 'abc123',
      nostrEventId: 'nostr-event-123',
    });

    expect(result).not.toBeNull();
    expect(result.category).toBe('nudity');
    expect(result.status).toBe('confirmed');
    expect(result.nostrEventId).toBe('nostr-event-123');
  });

  it('maps negation to rejected status', () => {
    const result = buildNostrLabelFromAtproto({
      val: 'nudity',
      neg: true,
      sha256: 'abc123',
      nostrEventId: 'nostr-event-123',
    });

    expect(result.status).toBe('rejected');
  });

  it('maps takedown to deletion action', () => {
    const result = buildNostrLabelFromAtproto({
      val: '!takedown',
      neg: false,
      sha256: 'abc123',
      nostrEventId: 'nostr-event-123',
    });

    expect(result.action).toBe('delete');
    expect(result.category).toBeNull();
  });

  it('returns null for unknown labels', () => {
    const result = buildNostrLabelFromAtproto({
      val: 'custom-unknown-label',
      neg: false,
      sha256: 'abc123',
    });

    expect(result).toBeNull();
  });
});
