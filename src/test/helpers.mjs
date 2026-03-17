// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared test helpers and mock factories for divine-moderation-service tests
// ABOUTME: Provides KV, Queue mock builders and test data generators

/**
 * Build a mock KV namespace that captures operations.
 */
export function createMockKV(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix } = {}) => {
      const keys = [];
      for (const [k] of store) {
        if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys };
    },
    _store: store,
  };
}

/**
 * Build a mock Queue that captures sent messages.
 */
export function createMockQueue() {
  const messages = [];
  return {
    send: async (msg) => { messages.push(msg); },
    sendBatch: async (batch) => { messages.push(...batch); },
    _messages: messages,
  };
}

/**
 * Build a minimal env object for unit tests.
 */
export function createMockEnv(overrides = {}) {
  return {
    SERVICE_API_TOKEN: 'test-token-123',
    API_BEARER_TOKEN: '',
    MODERATION_API_KEY: '',
    ALLOW_DEV_ACCESS: 'false',
    CDN_DOMAIN: 'media.divine.video',
    TEAM_DOMAIN: 'divine',
    POLICY_AUD: 'test-aud',
    RELAY_ADMIN_URL: 'https://relay.divine.video',
    CF_ACCESS_CLIENT_ID: 'test-client-id',
    CF_ACCESS_CLIENT_SECRET: 'test-client-secret',
    NOSTR_PRIVATE_KEY: null,
    MODERATION_KV: createMockKV(),
    MODERATION_QUEUE: createMockQueue(),
    ...overrides,
  };
}

/**
 * Create a valid SHA256 hash for testing.
 */
export function testSha256(suffix = '0') {
  return ('a'.repeat(63) + suffix).slice(0, 64);
}

/**
 * Create a valid Nostr pubkey for testing.
 */
export function testPubkey(suffix = '0') {
  return ('b'.repeat(63) + suffix).slice(0, 64);
}

/**
 * Build a mock Request object.
 */
export function createRequest(method, path, { body, headers } = {}) {
  const url = `https://moderation.admin.divine.video${path}`;
  const init = { method, headers: new Headers(headers || {}) };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers.set('Content-Type', 'application/json');
  }
  return new Request(url, init);
}
