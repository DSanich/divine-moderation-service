// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM conversation storage (dm-store.mjs)
// ABOUTME: Verifies D1-backed message logging, dedup, and conversation queries

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeConversationId, logDm, getConversations, getConversation, getConversationByPubkey } from './dm-store.mjs';

/**
 * Create a mock D1 database that tracks calls and stores data in-memory
 */
function createMockDb() {
  const store = [];
  let idCounter = 0;

  return {
    _store: store,
    prepare: vi.fn((sql) => ({
      bind: vi.fn((...args) => ({
        run: vi.fn(async () => {
          if (sql.trim().toUpperCase().startsWith('INSERT')) {
            idCounter++;
            store.push({ id: idCounter, args, sql });
            return { meta: { last_row_id: idCounter } };
          }
          return { meta: {} };
        }),
        first: vi.fn(async () => {
          // For dedup check: SELECT id FROM dm_log WHERE nostr_event_id = ?
          if (sql.includes('nostr_event_id') && sql.includes('SELECT')) {
            const eventId = args[0];
            const found = store.find(row =>
              row.sql.includes('INSERT') && row.args[7] === eventId
            );
            return found ? { id: found.id } : null;
          }
          return null;
        }),
        all: vi.fn(async () => {
          // Return different results based on query type
          if (sql.includes('GROUP BY conversation_id') || sql.includes('ORDER BY last_message_at')) {
            // getConversations query
            return { results: store.filter(r => r.sql.includes('INSERT')).map(r => ({
              conversation_id: r.args[0],
              last_message_at: new Date().toISOString(),
              message_count: 1,
              sender_pubkey: r.args[3],
              recipient_pubkey: r.args[4],
              last_message: r.args[6],
              last_sha256: r.args[1],
              last_message_type: r.args[5]
            })) };
          }
          if (sql.includes('conversation_id = ?')) {
            // getConversation query
            const convId = args[0];
            return { results: store.filter(r =>
              r.sql.includes('INSERT') && r.args[0] === convId
            ).map(r => ({
              id: r.id,
              conversation_id: r.args[0],
              sha256: r.args[1],
              direction: r.args[2],
              sender_pubkey: r.args[3],
              recipient_pubkey: r.args[4],
              message_type: r.args[5],
              content: r.args[6],
              nostr_event_id: r.args[7],
              created_at: new Date().toISOString()
            })) };
          }
          if (sql.includes('sender_pubkey = ?') || sql.includes('recipient_pubkey = ?')) {
            // getConversationByPubkey query
            const pubkey = args[0];
            const matching = store.filter(r =>
              r.sql.includes('INSERT') && (r.args[3] === pubkey || r.args[4] === pubkey)
            );
            if (matching.length === 0) return { results: [] };
            return { results: [{ conversation_id: matching[0].args[0] }] };
          }
          return { results: [] };
        })
      })),
      run: vi.fn(async () => ({ meta: {} }))
    }))
  };
}

describe('DM Store - computeConversationId', () => {
  it('should produce a deterministic conversation ID', () => {
    const pubkeyA = 'a'.repeat(64);
    const pubkeyB = 'b'.repeat(64);

    const id1 = computeConversationId(pubkeyA, pubkeyB);
    const id2 = computeConversationId(pubkeyA, pubkeyB);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be order-independent (swapping pubkeys gives same ID)', () => {
    const pubkeyA = 'a'.repeat(64);
    const pubkeyB = 'b'.repeat(64);

    const idAB = computeConversationId(pubkeyA, pubkeyB);
    const idBA = computeConversationId(pubkeyB, pubkeyA);

    expect(idAB).toBe(idBA);
  });

  it('should produce different IDs for different pubkey pairs', () => {
    const id1 = computeConversationId('a'.repeat(64), 'b'.repeat(64));
    const id2 = computeConversationId('a'.repeat(64), 'c'.repeat(64));

    expect(id1).not.toBe(id2);
  });
});

describe('DM Store - logDm', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should store a message and return an id', async () => {
    const result = await logDm(mockDb, {
      conversationId: 'conv123',
      sha256: 'abc'.repeat(21) + 'a',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      messageType: 'moderation_notice',
      content: 'Your video has been removed.',
      nostrEventId: null
    });

    expect(result).toHaveProperty('id');
    expect(result.id).toBeGreaterThan(0);
  });

  it('should not create duplicate when same nostr_event_id is provided', async () => {
    const eventId = 'event_' + 'x'.repeat(59);

    // First insert
    const result1 = await logDm(mockDb, {
      conversationId: 'conv123',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'First message',
      nostrEventId: eventId
    });

    expect(result1).toHaveProperty('id');

    // Second insert with same event ID should return existing
    const result2 = await logDm(mockDb, {
      conversationId: 'conv123',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'Duplicate message',
      nostrEventId: eventId
    });

    expect(result2).toHaveProperty('id');
    expect(result2.id).toBe(result1.id);
  });

  it('should allow insert without nostrEventId (no dedup check)', async () => {
    const result = await logDm(mockDb, {
      conversationId: 'conv123',
      direction: 'incoming',
      senderPubkey: 'b'.repeat(64),
      recipientPubkey: 'a'.repeat(64),
      content: 'A reply',
      nostrEventId: null
    });

    expect(result).toHaveProperty('id');
    // prepare should have been called for INSERT but not for SELECT (no dedup)
    const prepareCalls = mockDb.prepare.mock.calls;
    const selectCalls = prepareCalls.filter(c => c[0].includes('SELECT') && c[0].includes('nostr_event_id'));
    expect(selectCalls).toHaveLength(0);
  });
});

describe('DM Store - getConversations', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should return conversations ordered by latest message', async () => {
    // Insert two messages in different conversations
    await logDm(mockDb, {
      conversationId: 'conv_old',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'Older message'
    });

    await logDm(mockDb, {
      conversationId: 'conv_new',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'c'.repeat(64),
      content: 'Newer message'
    });

    const conversations = await getConversations(mockDb);

    expect(Array.isArray(conversations)).toBe(true);
    expect(conversations.length).toBe(2);
    // Each conversation should have required fields
    for (const conv of conversations) {
      expect(conv).toHaveProperty('conversation_id');
      expect(conv).toHaveProperty('last_message');
      expect(conv).toHaveProperty('sender_pubkey');
      expect(conv).toHaveProperty('recipient_pubkey');
    }
  });

  it('should return empty array when no conversations exist', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [] }))
        }))
      }))
    };

    const conversations = await getConversations(emptyDb);
    expect(conversations).toEqual([]);
  });
});

describe('DM Store - getConversation', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should return messages in chronological order', async () => {
    const convId = 'conv_thread';

    await logDm(mockDb, {
      conversationId: convId,
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'First message'
    });

    await logDm(mockDb, {
      conversationId: convId,
      direction: 'incoming',
      senderPubkey: 'b'.repeat(64),
      recipientPubkey: 'a'.repeat(64),
      content: 'Reply'
    });

    const messages = await getConversation(mockDb, convId);

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe('First message');
    expect(messages[1].content).toBe('Reply');
    expect(messages[0].direction).toBe('outgoing');
    expect(messages[1].direction).toBe('incoming');
  });

  it('should return empty array for unknown conversation', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [] }))
        }))
      }))
    };

    const messages = await getConversation(emptyDb, 'nonexistent');
    expect(messages).toEqual([]);
  });
});

describe('DM Store - getConversationByPubkey', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should find conversation by participant pubkey', async () => {
    const senderPubkey = 'a'.repeat(64);
    const recipientPubkey = 'b'.repeat(64);
    const convId = computeConversationId(senderPubkey, recipientPubkey);

    await logDm(mockDb, {
      conversationId: convId,
      direction: 'outgoing',
      senderPubkey,
      recipientPubkey,
      content: 'Hello there'
    });

    const messages = await getConversationByPubkey(mockDb, recipientPubkey);

    expect(messages).not.toBeNull();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].content).toBe('Hello there');
  });

  it('should return null when pubkey has no conversations', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn((...args) => ({
          all: vi.fn(async () => ({ results: [] }))
        }))
      }))
    };

    const result = await getConversationByPubkey(emptyDb, 'z'.repeat(64));
    expect(result).toBeNull();
  });
});
