# Test Coverage Improvement Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise test coverage from ~37% to ~80% of source modules, prioritizing security-critical auth, admin CRUD operations, input validation, and database layer.

**Architecture:** All tests use `@cloudflare/vitest-pool-workers` which simulates the Cloudflare Workers runtime with D1, KV, and Queue bindings available via `env`. Tests are co-located `.test.mjs` files. Pure functions are extracted where possible for easier unit testing. Integration tests use the Workers pool to test full request→response flows.

**Tech Stack:** Vitest 2.x, @cloudflare/vitest-pool-workers 0.5.x, Cloudflare Workers (D1, KV, Queues)

---

## Chunk 1: Test Infrastructure & Pure Function Tests

### Task 1: Add coverage reporting to vitest config

**Files:**
- Modify: `vitest.config.mjs`

- [ ] **Step 1: Update vitest config with coverage settings**

```javascript
// vitest.config.mjs
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.mjs'],
      exclude: ['src/**/*.test.mjs', 'src/admin/*.html'],
    },
  },
});
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add vitest.config.mjs
git commit -m "chore: add coverage reporting to vitest config"
```

### Task 2: Create shared test helpers

**Files:**
- Create: `src/test/helpers.mjs`

- [ ] **Step 1: Create test helper module with mock factories**

```javascript
// src/test/helpers.mjs
// ABOUTME: Shared test helpers and mock factories for divine-moderation-service tests
// ABOUTME: Provides D1, KV, Queue, and env mock builders

/**
 * Build a mock D1 database with optional pre-seeded data.
 * Uses the real env.BLOSSOM_DB from vitest-pool-workers when available.
 */
export function createMockKV(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value, opts) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix } = {}) => {
      const keys = [];
      for (const [k] of store) {
        if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys };
    },
    _store: store, // Exposed for test assertions
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
    _messages: messages, // Exposed for test assertions
  };
}

/**
 * Build a minimal env object for unit tests that don't need the full Workers pool.
 * For integration tests, prefer the real env from SELF.
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
```

- [ ] **Step 2: Commit**

```bash
git add src/test/helpers.mjs
git commit -m "chore: add shared test helpers and mock factories"
```

### Task 3: Input validation function tests

**Files:**
- Create: `src/validation.mjs` (extract from index.mjs)
- Create: `src/validation.test.mjs`
- Modify: `src/index.mjs` (import from validation.mjs)

- [ ] **Step 1: Extract validation functions into their own module**

Create `src/validation.mjs` with the following functions extracted from `src/index.mjs` lines 210-287:

```javascript
// src/validation.mjs
// ABOUTME: Input validation and parsing helpers used across the moderation service
// ABOUTME: Extracted from index.mjs for testability

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
```

- [ ] **Step 2: Write the failing tests**

```javascript
// src/validation.test.mjs
// ABOUTME: Tests for input validation and parsing helpers
// ABOUTME: Covers SHA256, pubkey, identifier validation, JSON parsing, imeta tag parsing

import { describe, it, expect } from 'vitest';
import {
  isValidSha256,
  isValidLookupIdentifier,
  isValidPubkey,
  parseMaybeJson,
  getEventTagValue,
  parseImetaParams,
  extractShaFromUrl,
  extractMediaShaFromEvent,
} from './validation.mjs';

describe('isValidSha256', () => {
  it('accepts valid lowercase hex', () => {
    expect(isValidSha256('a'.repeat(64))).toBe(true);
  });

  it('accepts valid uppercase hex', () => {
    expect(isValidSha256('A'.repeat(64))).toBe(true);
  });

  it('accepts valid mixed case hex', () => {
    expect(isValidSha256('aAbBcCdDeEfF0011223344556677889900112233445566778899aAbBcCdDeEfF')).toBe(true);
  });

  it('rejects too short', () => {
    expect(isValidSha256('a'.repeat(63))).toBe(false);
  });

  it('rejects too long', () => {
    expect(isValidSha256('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidSha256('g'.repeat(64))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSha256('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidSha256(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidSha256(undefined)).toBe(false);
  });

  it('rejects number', () => {
    expect(isValidSha256(123)).toBe(false);
  });
});

describe('isValidPubkey', () => {
  it('accepts valid 64-char hex (same as sha256)', () => {
    expect(isValidPubkey('b'.repeat(64))).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(isValidPubkey('not-a-pubkey')).toBe(false);
  });
});

describe('isValidLookupIdentifier', () => {
  it('accepts sha256 hash', () => {
    expect(isValidLookupIdentifier('a'.repeat(64))).toBe(true);
  });

  it('accepts short string', () => {
    expect(isValidLookupIdentifier('abc')).toBe(true);
  });

  it('accepts max length (255)', () => {
    expect(isValidLookupIdentifier('x'.repeat(255))).toBe(true);
  });

  it('rejects over max length', () => {
    expect(isValidLookupIdentifier('x'.repeat(256))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidLookupIdentifier('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidLookupIdentifier(null)).toBe(false);
  });

  it('rejects number', () => {
    expect(isValidLookupIdentifier(42)).toBe(false);
  });
});

describe('parseMaybeJson', () => {
  it('parses valid JSON string', () => {
    expect(parseMaybeJson('{"a":1}', null)).toEqual({ a: 1 });
  });

  it('returns fallback for invalid JSON string', () => {
    expect(parseMaybeJson('not json', 'fallback')).toBe('fallback');
  });

  it('returns fallback for null', () => {
    expect(parseMaybeJson(null, 'default')).toBe('default');
  });

  it('returns fallback for undefined', () => {
    expect(parseMaybeJson(undefined, [])).toEqual([]);
  });

  it('returns object directly if already parsed', () => {
    const obj = { key: 'val' };
    expect(parseMaybeJson(obj, null)).toBe(obj);
  });

  it('returns array directly if already parsed', () => {
    const arr = [1, 2, 3];
    expect(parseMaybeJson(arr, null)).toBe(arr);
  });
});

describe('getEventTagValue', () => {
  it('returns value for existing tag', () => {
    const tags = [['d', 'test-id'], ['p', 'pubkey123']];
    expect(getEventTagValue(tags, 'd')).toBe('test-id');
  });

  it('returns null for missing tag', () => {
    const tags = [['d', 'test-id']];
    expect(getEventTagValue(tags, 'x')).toBeNull();
  });

  it('returns null for null tags', () => {
    expect(getEventTagValue(null, 'd')).toBeNull();
  });

  it('returns null for empty tags', () => {
    expect(getEventTagValue([], 'd')).toBeNull();
  });
});

describe('parseImetaParams', () => {
  it('parses imeta tag with multiple params', () => {
    const tags = [['imeta', 'url https://example.com/video.mp4', 'x ' + 'a'.repeat(64), 'm video/mp4']];
    const result = parseImetaParams(tags);
    expect(result.url).toBe('https://example.com/video.mp4');
    expect(result.x).toBe('a'.repeat(64));
    expect(result.m).toBe('video/mp4');
  });

  it('returns empty object when no imeta tag', () => {
    expect(parseImetaParams([['d', 'test']])).toEqual({});
  });

  it('returns empty object for null tags', () => {
    expect(parseImetaParams(null)).toEqual({});
  });

  it('skips entries without space separator', () => {
    const tags = [['imeta', 'nospace', 'url https://example.com']];
    const result = parseImetaParams(tags);
    expect(result.nospace).toBeUndefined();
    expect(result.url).toBe('https://example.com');
  });

  it('skips null entries in tag array', () => {
    const tags = [['imeta', null, 'url https://example.com']];
    const result = parseImetaParams(tags);
    expect(result.url).toBe('https://example.com');
  });
});

describe('extractShaFromUrl', () => {
  it('extracts sha256 from CDN URL', () => {
    const sha = 'a'.repeat(64);
    expect(extractShaFromUrl(`https://media.divine.video/${sha}`)).toBe(sha);
  });

  it('extracts sha256 from URL with extension', () => {
    const sha = 'b'.repeat(64);
    expect(extractShaFromUrl(`https://media.divine.video/${sha}.mp4`)).toBe(sha);
  });

  it('lowercases uppercase hash in URL', () => {
    const sha = 'A'.repeat(64);
    expect(extractShaFromUrl(`https://example.com/${sha}`)).toBe('a'.repeat(64));
  });

  it('returns null for URL without hash', () => {
    expect(extractShaFromUrl('https://example.com/video.mp4')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(extractShaFromUrl(null)).toBeNull();
    expect(extractShaFromUrl(undefined)).toBeNull();
    expect(extractShaFromUrl(123)).toBeNull();
  });
});

describe('extractMediaShaFromEvent', () => {
  const sha = 'c'.repeat(64);

  it('extracts from imeta x param', () => {
    const event = { tags: [['imeta', `x ${sha}`]] };
    expect(extractMediaShaFromEvent(event)).toBe(sha);
  });

  it('extracts from x tag', () => {
    const event = { tags: [['x', sha]] };
    expect(extractMediaShaFromEvent(event)).toBe(sha);
  });

  it('extracts from imeta url param', () => {
    const event = { tags: [['imeta', `url https://cdn.example.com/${sha}.mp4`]] };
    expect(extractMediaShaFromEvent(event)).toBe(sha);
  });

  it('extracts from url tag', () => {
    const event = { tags: [['url', `https://cdn.example.com/${sha}`]] };
    expect(extractMediaShaFromEvent(event)).toBe(sha);
  });

  it('returns null for event with no sha', () => {
    const event = { tags: [['d', 'test']] };
    expect(extractMediaShaFromEvent(event)).toBeNull();
  });

  it('returns null for null event', () => {
    expect(extractMediaShaFromEvent(null)).toBeNull();
  });

  it('returns null for event with no tags', () => {
    expect(extractMediaShaFromEvent({})).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail (functions not exported yet)**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/validation.test.mjs`
Expected: FAIL — validation.mjs doesn't exist yet

- [ ] **Step 4: Create the validation.mjs file (code from Step 1)**

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/validation.test.mjs`
Expected: All tests PASS

- [ ] **Step 6: Update index.mjs to import from validation.mjs**

Replace the inline function definitions (lines ~210-287 of `src/index.mjs`) with imports:

```javascript
import {
  isValidSha256,
  isValidLookupIdentifier,
  isValidPubkey,
  parseMaybeJson,
  getEventTagValue,
  parseImetaParams,
  extractShaFromUrl,
  extractMediaShaFromEvent,
} from './validation.mjs';
```

Remove the original function definitions from index.mjs (lines 210-287).

- [ ] **Step 7: Run all tests to verify nothing broke**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run`
Expected: All tests PASS (existing + new)

- [ ] **Step 8: Commit**

```bash
git add src/validation.mjs src/validation.test.mjs src/index.mjs
git commit -m "feat: extract validation helpers with comprehensive tests"
```

---

## Chunk 2: Auth & Response Helper Tests

### Task 4: Auth function tests

**Files:**
- Create: `src/admin/auth.test.mjs`
- Reference: `src/admin/auth.mjs` (52 lines)

The `auth.mjs` module has two functions: `getAuthenticatedUser(request)` which reads the `Cf-Access-Authenticated-User-Email` header, and `requireAuth(request, env)` which calls the zero trust verifier or allows dev bypass.

- [ ] **Step 1: Write auth tests**

```javascript
// src/admin/auth.test.mjs
// ABOUTME: Tests for admin authentication functions
// ABOUTME: Covers getAuthenticatedUser, requireAuth, and dev mode bypass

import { describe, it, expect } from 'vitest';
import { getAuthenticatedUser, requireAuth } from './auth.mjs';

describe('getAuthenticatedUser', () => {
  it('returns email from Cf-Access-Authenticated-User-Email header', () => {
    const request = new Request('https://example.com', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'admin@divine.video' },
    });
    expect(getAuthenticatedUser(request)).toBe('admin@divine.video');
  });

  it('returns null when header is missing', () => {
    const request = new Request('https://example.com');
    expect(getAuthenticatedUser(request)).toBeNull();
  });

  it('returns null when header is empty string', () => {
    const request = new Request('https://example.com', {
      headers: { 'Cf-Access-Authenticated-User-Email': '' },
    });
    // Empty string is falsy, so should return null
    expect(getAuthenticatedUser(request)).toBeFalsy();
  });
});

describe('requireAuth', () => {
  it('allows access when ALLOW_DEV_ACCESS is true', async () => {
    const request = new Request('https://example.com');
    const env = { ALLOW_DEV_ACCESS: 'true' };
    const result = await requireAuth(request, env);
    expect(result).toBeNull(); // null means "no error, proceed"
  });

  it('returns 401 response when no auth provided and dev mode off', async () => {
    const request = new Request('https://example.com');
    const env = {
      ALLOW_DEV_ACCESS: 'false',
      TEAM_DOMAIN: 'divine',
      POLICY_AUD: 'test-aud',
    };
    const result = await requireAuth(request, env);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it('returns 401 when Cf-Access-Jwt-Assertion header is invalid', async () => {
    const request = new Request('https://example.com', {
      headers: { 'Cf-Access-Jwt-Assertion': 'invalid-jwt-token' },
    });
    const env = {
      ALLOW_DEV_ACCESS: 'false',
      TEAM_DOMAIN: 'divine',
      POLICY_AUD: 'test-aud',
    };
    const result = await requireAuth(request, env);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/admin/auth.test.mjs`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/admin/auth.test.mjs
git commit -m "test: add auth function tests (getAuthenticatedUser, requireAuth)"
```

### Task 5: API auth function tests (authenticateApiRequest, verifyLegacyBearerAuth)

**Files:**
- Create: `src/auth-api.mjs` (extract from index.mjs)
- Create: `src/auth-api.test.mjs`
- Modify: `src/index.mjs` (import from auth-api.mjs)

- [ ] **Step 1: Extract API auth functions into their own module**

Extract from `src/index.mjs` lines ~142-208: `getConfiguredBearerTokens`, `authenticateApiRequest`, `apiUnauthorizedResponse`, `authSourceFromVerification`, `verifyLegacyBearerAuth`.

```javascript
// src/auth-api.mjs
// ABOUTME: API-level authentication functions for bearer token and Zero Trust JWT validation
// ABOUTME: Used by both public API (bearer token) and admin API (CF Access JWT) endpoints

import { verifyZeroTrustJWT } from './admin/zerotrust.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function getConfiguredBearerTokens(env) {
  return [env.SERVICE_API_TOKEN, env.API_BEARER_TOKEN, env.MODERATION_API_KEY]
    .filter((value, index, all) => typeof value === 'string' && value.length > 0 && all.indexOf(value) === index);
}

export async function authenticateApiRequest(request, env) {
  if (env.ALLOW_DEV_ACCESS === 'true') {
    return { valid: true, email: 'dev@localhost', isServiceToken: false };
  }

  const authHeader = request.headers.get('Authorization');
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const configuredTokens = getConfiguredBearerTokens(env);
  if (bearerToken && configuredTokens.includes(bearerToken)) {
    return { valid: true, email: 'service@internal', isServiceToken: true };
  }

  const jwtToken = request.headers.get('cf-access-jwt-assertion');
  if (jwtToken) {
    try {
      return await verifyZeroTrustJWT(jwtToken, env);
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  if (configuredTokens.length === 0) {
    return { valid: false, error: 'No bearer token configured (SERVICE_API_TOKEN/API_BEARER_TOKEN/MODERATION_API_KEY)' };
  }

  return { valid: false, error: 'Missing bearer token or Cloudflare Access JWT' };
}

export function apiUnauthorizedResponse(verification) {
  return new Response(JSON.stringify({ error: `Unauthorized - ${verification.error}` }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}

export function authSourceFromVerification(verification) {
  return verification.email
    ? `user:${verification.email}`
    : `service-token:${verification.payload?.sub || 'unknown'}`;
}

export function verifyLegacyBearerAuth(request, env) {
  const configuredTokens = getConfiguredBearerTokens(env);
  if (configuredTokens.length === 0) {
    return new Response(JSON.stringify({ error: 'Server misconfigured — no auth token set' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing Authorization: Bearer <token>' }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  const token = authHeader.slice(7);
  if (!configuredTokens.includes(token)) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  return null; // Auth passed
}
```

- [ ] **Step 2: Write the tests**

```javascript
// src/auth-api.test.mjs
// ABOUTME: Tests for API-level authentication (bearer tokens, dev mode bypass, JWT)
// ABOUTME: Critical security tests — ensures unauthorized requests are rejected

import { describe, it, expect } from 'vitest';
import {
  getConfiguredBearerTokens,
  authenticateApiRequest,
  apiUnauthorizedResponse,
  authSourceFromVerification,
  verifyLegacyBearerAuth,
} from './auth-api.mjs';

describe('getConfiguredBearerTokens', () => {
  it('returns all configured tokens', () => {
    const env = {
      SERVICE_API_TOKEN: 'token-a',
      API_BEARER_TOKEN: 'token-b',
      MODERATION_API_KEY: 'token-c',
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['token-a', 'token-b', 'token-c']);
  });

  it('filters out empty strings', () => {
    const env = {
      SERVICE_API_TOKEN: 'token-a',
      API_BEARER_TOKEN: '',
      MODERATION_API_KEY: undefined,
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['token-a']);
  });

  it('deduplicates identical tokens', () => {
    const env = {
      SERVICE_API_TOKEN: 'same-token',
      API_BEARER_TOKEN: 'same-token',
      MODERATION_API_KEY: 'same-token',
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['same-token']);
  });

  it('returns empty array when nothing configured', () => {
    expect(getConfiguredBearerTokens({})).toEqual([]);
  });
});

describe('authenticateApiRequest', () => {
  it('allows dev access when ALLOW_DEV_ACCESS is true', async () => {
    const request = new Request('https://example.com');
    const env = { ALLOW_DEV_ACCESS: 'true' };
    const result = await authenticateApiRequest(request, env);
    expect(result.valid).toBe(true);
    expect(result.email).toBe('dev@localhost');
  });

  it('validates correct bearer token', async () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const env = { ALLOW_DEV_ACCESS: 'false', SERVICE_API_TOKEN: 'test-token' };
    const result = await authenticateApiRequest(request, env);
    expect(result.valid).toBe(true);
    expect(result.isServiceToken).toBe(true);
  });

  it('rejects wrong bearer token', async () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const env = { ALLOW_DEV_ACCESS: 'false', SERVICE_API_TOKEN: 'correct-token' };
    const result = await authenticateApiRequest(request, env);
    expect(result.valid).toBe(false);
  });

  it('rejects missing auth when tokens are configured', async () => {
    const request = new Request('https://example.com');
    const env = { ALLOW_DEV_ACCESS: 'false', SERVICE_API_TOKEN: 'test-token' };
    const result = await authenticateApiRequest(request, env);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing bearer token');
  });

  it('rejects with config error when no tokens configured and no JWT', async () => {
    const request = new Request('https://example.com');
    const env = { ALLOW_DEV_ACCESS: 'false' };
    const result = await authenticateApiRequest(request, env);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No bearer token configured');
  });
});

describe('verifyLegacyBearerAuth', () => {
  it('returns null (pass) for valid token', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer good-token' },
    });
    const env = { SERVICE_API_TOKEN: 'good-token' };
    expect(verifyLegacyBearerAuth(request, env)).toBeNull();
  });

  it('returns 401 for missing Authorization header', () => {
    const request = new Request('https://example.com');
    const env = { SERVICE_API_TOKEN: 'token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(401);
  });

  it('returns 403 for invalid token', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    const env = { SERVICE_API_TOKEN: 'good-token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(403);
  });

  it('returns 500 when no tokens configured', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer anything' },
    });
    const result = verifyLegacyBearerAuth(request, {});
    expect(result.status).toBe(500);
  });

  it('rejects non-Bearer auth schemes', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    const env = { SERVICE_API_TOKEN: 'token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(401);
  });
});

describe('apiUnauthorizedResponse', () => {
  it('returns 401 with error message', async () => {
    const resp = apiUnauthorizedResponse({ error: 'token expired' });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toContain('token expired');
  });
});

describe('authSourceFromVerification', () => {
  it('returns user email when present', () => {
    expect(authSourceFromVerification({ email: 'admin@test.com' })).toBe('user:admin@test.com');
  });

  it('returns service token sub when no email', () => {
    expect(authSourceFromVerification({ payload: { sub: 'svc-123' } })).toBe('service-token:svc-123');
  });

  it('returns unknown when no email and no sub', () => {
    expect(authSourceFromVerification({})).toBe('service-token:unknown');
  });
});
```

- [ ] **Step 3: Create auth-api.mjs file**

- [ ] **Step 4: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/auth-api.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Update index.mjs to import from auth-api.mjs**

Replace inline definitions with imports. Remove lines ~142-208 from index.mjs.

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/auth-api.mjs src/auth-api.test.mjs src/index.mjs
git commit -m "feat: extract API auth functions with comprehensive tests"
```

---

## Chunk 3: Database Layer Tests

### Task 6: Offender tracker tests

This task is obsolete. `src/offender-tracker.mjs` and its tests were removed as dead code in issue #18 / PR #80, so no coverage work remains here.

### Task 7: Reports system tests

**Files:**
- Create: `src/reports.test.mjs`
- Reference: `src/reports.mjs` (65 lines)

- [ ] **Step 1: Write reports tests**

```javascript
// src/reports.test.mjs
// ABOUTME: Tests for NIP-56 user report tracking and auto-escalation
// ABOUTME: Covers report dedup, count aggregation, and escalation thresholds (3→REVIEW, 5→AGE_RESTRICTED)

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { initReportsTable, addReport, getReportCount } from './reports.mjs';
import { testSha256, testPubkey } from './test/helpers.mjs';

describe('reports', () => {
  beforeEach(async () => {
    await initReportsTable(env.BLOSSOM_DB);
    await env.BLOSSOM_DB.prepare('DELETE FROM user_reports').run();
  });

  describe('addReport', () => {
    it('adds a new report', async () => {
      const result = await addReport(env.BLOSSOM_DB, {
        sha256: testSha256('1'),
        reporter_pubkey: testPubkey('1'),
        report_type: 'nudity',
        reason: 'test report',
      });
      expect(result.escalate).toBe(false);
    });

    it('deduplicates same reporter for same sha256', async () => {
      const sha = testSha256('2');
      const reporter = testPubkey('2');
      await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: reporter, report_type: 'nudity' });
      await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: reporter, report_type: 'nudity' });
      const count = await getReportCount(env.BLOSSOM_DB, sha);
      expect(count).toBe(1);
    });

    it('counts different reporters separately', async () => {
      const sha = testSha256('3');
      await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey('a'), report_type: 'nudity' });
      await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey('b'), report_type: 'nudity' });
      const count = await getReportCount(env.BLOSSOM_DB, sha);
      expect(count).toBe(2);
    });

    it('escalates to REVIEW at 3 unique reporters', async () => {
      const sha = testSha256('4');
      await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey('a'), report_type: 'nudity' });
      await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey('b'), report_type: 'nudity' });
      const result = await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey('c'), report_type: 'nudity' });
      expect(result.escalate).toBe(true);
      expect(result.level).toBe('REVIEW');
    });

    it('escalates to AGE_RESTRICTED at 5 unique reporters', async () => {
      const sha = testSha256('5');
      for (let i = 0; i < 4; i++) {
        await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey(String(i)), report_type: 'nudity' });
      }
      const result = await addReport(env.BLOSSOM_DB, { sha256: sha, reporter_pubkey: testPubkey('4'), report_type: 'nudity' });
      expect(result.escalate).toBe(true);
      expect(result.level).toBe('AGE_RESTRICTED');
    });
  });

  describe('getReportCount', () => {
    it('returns 0 for unreported sha256', async () => {
      const count = await getReportCount(env.BLOSSOM_DB, testSha256('none'));
      expect(count).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/reports.test.mjs`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/reports.test.mjs
git commit -m "test: add user reports tracking and escalation threshold tests"
```

---

## Chunk 4: Text Classifier & Relay Client Tests

### Task 8: Text classifier tests

**Files:**
- Create: `src/moderation/text-classifier.test.mjs`
- Reference: `src/moderation/text-classifier.mjs` (168 lines)

- [ ] **Step 1: Write text classifier tests**

```javascript
// src/moderation/text-classifier.test.mjs
// ABOUTME: Tests for VTT transcript text analysis
// ABOUTME: Covers hate speech, threats, profanity detection and VTT parsing

import { describe, it, expect } from 'vitest';
import { classifyText, parseVttText } from './text-classifier.mjs';

describe('parseVttText', () => {
  it('strips VTT header', () => {
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world';
    expect(parseVttText(vtt)).toContain('Hello world');
    expect(parseVttText(vtt)).not.toContain('WEBVTT');
  });

  it('strips timestamps', () => {
    const vtt = '00:00:00.000 --> 00:00:05.000\nHello\n00:00:05.000 --> 00:00:10.000\nWorld';
    const result = parseVttText(vtt);
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('returns empty string for null input', () => {
    expect(parseVttText(null)).toBe('');
    expect(parseVttText(undefined)).toBe('');
  });

  it('handles plain text (no VTT formatting)', () => {
    expect(parseVttText('just plain text')).toContain('just plain text');
  });
});

describe('classifyText', () => {
  it('returns zero scores for benign text', () => {
    const result = classifyText('This is a beautiful sunny day at the park');
    expect(result.hate_speech).toBe(0);
    expect(result.threats).toBe(0);
    expect(result.self_harm).toBe(0);
  });

  it('detects profanity', () => {
    const result = classifyText('What the fuck is going on here');
    expect(result.profanity).toBeGreaterThan(0);
  });

  it('returns scores between 0 and 1', () => {
    const result = classifyText('Some text with various content');
    for (const [, score] of Object.entries(result)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('returns all six categories', () => {
    const result = classifyText('test');
    expect(result).toHaveProperty('hate_speech');
    expect(result).toHaveProperty('threats');
    expect(result).toHaveProperty('harassment');
    expect(result).toHaveProperty('self_harm');
    expect(result).toHaveProperty('grooming');
    expect(result).toHaveProperty('profanity');
  });

  it('handles empty string', () => {
    const result = classifyText('');
    expect(result.profanity).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/moderation/text-classifier.test.mjs`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/moderation/text-classifier.test.mjs
git commit -m "test: add text classifier and VTT parser tests"
```

### Task 9: Relay client tests (parseVideoEventMetadata, isOriginalVine)

**Files:**
- Create: `src/nostr/relay-client.test.mjs`
- Reference: `src/nostr/relay-client.mjs` (252 lines)

- [ ] **Step 1: Write relay client tests for pure functions**

```javascript
// src/nostr/relay-client.test.mjs
// ABOUTME: Tests for Nostr relay client metadata parsing
// ABOUTME: Covers video event metadata extraction and Vine detection

import { describe, it, expect } from 'vitest';
import { parseVideoEventMetadata, isOriginalVine } from './relay-client.mjs';

describe('parseVideoEventMetadata', () => {
  it('extracts title from title tag', () => {
    const event = {
      kind: 34236,
      content: '',
      tags: [['title', 'My Video Title']],
      pubkey: 'a'.repeat(64),
    };
    expect(parseVideoEventMetadata(event).title).toBe('My Video Title');
  });

  it('extracts title from subject tag as fallback', () => {
    const event = {
      kind: 34236,
      content: '',
      tags: [['subject', 'Subject Title']],
      pubkey: 'a'.repeat(64),
    };
    expect(parseVideoEventMetadata(event).title).toBe('Subject Title');
  });

  it('extracts author from author tag', () => {
    const event = {
      kind: 34236,
      content: '',
      tags: [['author', 'VideoCreator']],
      pubkey: 'a'.repeat(64),
    };
    expect(parseVideoEventMetadata(event).author).toBe('VideoCreator');
  });

  it('extracts client tag', () => {
    const event = {
      kind: 34236,
      content: '',
      tags: [['client', 'divine-mobile']],
      pubkey: 'a'.repeat(64),
    };
    expect(parseVideoEventMetadata(event).client).toBe('divine-mobile');
  });

  it('returns null for null event', () => {
    expect(parseVideoEventMetadata(null)).toBeNull();
  });

  it('returns metadata with content from event', () => {
    const event = {
      kind: 34236,
      content: 'Check out this video!',
      tags: [],
      pubkey: 'a'.repeat(64),
    };
    const meta = parseVideoEventMetadata(event);
    expect(meta.content).toBe('Check out this video!');
  });
});

describe('isOriginalVine', () => {
  it('returns true for Vine platform event', () => {
    const event = {
      kind: 34236,
      tags: [['platform', 'vine']],
      pubkey: 'a'.repeat(64),
      created_at: 1500000000, // 2017
    };
    expect(isOriginalVine(event)).toBe(true);
  });

  it('returns true for vine-archive client', () => {
    const event = {
      kind: 34236,
      tags: [['client', 'vine-archive']],
      pubkey: 'a'.repeat(64),
      created_at: 1500000000,
    };
    expect(isOriginalVine(event)).toBe(true);
  });

  it('returns false for divine-mobile client', () => {
    const event = {
      kind: 34236,
      tags: [['client', 'divine-mobile']],
      pubkey: 'a'.repeat(64),
      created_at: Date.now() / 1000,
    };
    expect(isOriginalVine(event)).toBe(false);
  });

  it('returns false for null event', () => {
    expect(isOriginalVine(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/nostr/relay-client.test.mjs`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/nostr/relay-client.test.mjs
git commit -m "test: add relay client metadata parsing and Vine detection tests"
```

---

## Chunk 5: Relay Poller & Integration Tests

### Task 10: Relay poller pure function tests

**Files:**
- Create: `src/nostr/relay-poller.test.mjs`
- Reference: `src/nostr/relay-poller.mjs` (354 lines)

- [ ] **Step 1: Write relay poller tests for extractors**

```javascript
// src/nostr/relay-poller.test.mjs
// ABOUTME: Tests for relay polling helper functions
// ABOUTME: Covers SHA256 extraction from imeta tags and video URL extraction

import { describe, it, expect } from 'vitest';
import { extractSha256FromImeta, extractVideoUrlFromEvent } from './relay-poller.mjs';

describe('extractSha256FromImeta', () => {
  const sha = 'c'.repeat(64);

  it('extracts from imeta tag x param', () => {
    const event = { tags: [['imeta', `x ${sha}`]] };
    expect(extractSha256FromImeta(event)).toBe(sha);
  });

  it('extracts from x tag directly', () => {
    const event = { tags: [['x', sha]] };
    expect(extractSha256FromImeta(event)).toBe(sha);
  });

  it('returns null when no sha256 found', () => {
    const event = { tags: [['d', 'test']] };
    expect(extractSha256FromImeta(event)).toBeNull();
  });

  it('returns null for event with no tags', () => {
    expect(extractSha256FromImeta({ tags: [] })).toBeNull();
  });
});

describe('extractVideoUrlFromEvent', () => {
  const sha = 'd'.repeat(64);

  it('extracts URL from imeta url param', () => {
    const event = { tags: [['imeta', `url https://cdn.example.com/${sha}.mp4`, `x ${sha}`]] };
    const url = extractVideoUrlFromEvent(event);
    expect(url).toContain(sha);
  });

  it('falls back to r tag', () => {
    const event = { tags: [['r', `https://cdn.example.com/${sha}.mp4`]] };
    const url = extractVideoUrlFromEvent(event);
    expect(url).toContain(sha);
  });

  it('constructs URL from sha256 as last resort', () => {
    const event = { tags: [['x', sha]] };
    const url = extractVideoUrlFromEvent(event);
    expect(url).toContain(sha);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/nostr/relay-poller.test.mjs`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/nostr/relay-poller.test.mjs
git commit -m "test: add relay poller extraction function tests"
```

### Task 11: Admin moderate endpoint integration tests

**Files:**
- Modify: `src/index.test.mjs` (add new describe block)

These tests use the `SELF` binding from `@cloudflare/vitest-pool-workers` to make real HTTP requests against the worker. They need the admin hostname and dev access enabled.

- [ ] **Step 1: Add moderate endpoint tests to index.test.mjs**

Append the following to `src/index.test.mjs`:

```javascript
describe('POST /admin/api/moderate/:sha256', () => {
  it('rejects unauthenticated requests', async () => {
    const resp = await SELF.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/moderate/' + 'a'.repeat(64), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SAFE' }),
      })
    );
    expect(resp.status).toBe(401);
  });

  it('rejects invalid action', async () => {
    const resp = await SELF.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/moderate/' + 'a'.repeat(64), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'INVALID_ACTION' }),
      })
    );
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('Invalid action');
  });

  it('creates manual override for new sha256', async () => {
    const sha = 'f'.repeat(64);
    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'SAFE', reason: 'Looks fine' }),
      })
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe('SAFE');
  });

  it('records previousAction on override', async () => {
    const sha = 'e'.repeat(64);
    // First moderation
    await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'AGE_RESTRICTED' }),
      })
    );
    // Override
    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'SAFE', reason: 'False positive' }),
      })
    );
    const body = await resp.json();
    expect(body.previousAction).toBe('AGE_RESTRICTED');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/index.test.mjs`
Expected: All tests PASS (existing + new)

Note: These integration tests depend on `ALLOW_DEV_ACCESS=true` or valid CF Access headers being accepted. If `requireAuth` blocks them, we need to check the wrangler.toml vars. The existing tests in index.test.mjs already test admin endpoints so the auth pattern should work.

- [ ] **Step 3: Commit**

```bash
git add src/index.test.mjs
git commit -m "test: add admin moderate endpoint integration tests"
```

### Task 12: Verify-category endpoint integration tests

**Files:**
- Modify: `src/index.test.mjs` (add new describe block)

- [ ] **Step 1: Add verify-category tests**

Append to `src/index.test.mjs`:

```javascript
describe('POST /admin/api/verify-category/:sha256', () => {
  it('rejects invalid category', async () => {
    const sha = 'a'.repeat(64);
    // First create a moderation result
    await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'REVIEW' }),
      })
    );

    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ category: 'INVALID_CAT', status: 'confirmed' }),
      })
    );
    expect(resp.status).toBe(400);
  });

  it('rejects invalid status', async () => {
    const sha = 'b'.repeat(64);
    await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'REVIEW' }),
      })
    );

    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ category: 'nudity', status: 'maybe' }),
      })
    );
    expect(resp.status).toBe(400);
  });

  it('returns 404 for non-existent sha256', async () => {
    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${'c'.repeat(64)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ category: 'nudity', status: 'confirmed' }),
      })
    );
    expect(resp.status).toBe(404);
  });

  it('stores category verification', async () => {
    const sha = 'd'.repeat(64);
    // Create moderation result first
    await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'AGE_RESTRICTED', scores: { nudity: 0.9 } }),
      })
    );

    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ category: 'nudity', status: 'confirmed' }),
      })
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.categoryVerifications.nudity).toBe('confirmed');
  });

  it('auto-approves when all major flags rejected', async () => {
    const sha = '1'.repeat(64);
    // Create with high nudity score
    await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ action: 'AGE_RESTRICTED', scores: { nudity: 0.9 } }),
      })
    );

    // Reject nudity (the only major flag)
    const resp = await SELF.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@test.com',
        },
        body: JSON.stringify({ category: 'nudity', status: 'rejected' }),
      })
    );
    const body = await resp.json();
    expect(body.autoApproved).toBe(true);
    expect(body.newAction).toBe('SAFE');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/index.test.mjs`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.test.mjs
git commit -m "test: add verify-category endpoint and auto-approval tests"
```

---

## Chunk 6: Legacy API & Final Validation

### Task 13: Legacy scan endpoint tests

**Files:**
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Add legacy scan endpoint tests**

```javascript
describe('POST /api/v1/scan (legacy)', () => {
  it('rejects request without bearer token', async () => {
    const resp = await SELF.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: 'a'.repeat(64) }),
      })
    );
    expect(resp.status).toBe(401);
  });

  it('rejects invalid sha256', async () => {
    const resp = await SELF.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SERVICE_API_TOKEN}`,
        },
        body: JSON.stringify({ sha256: 'not-a-hash' }),
      })
    );
    expect(resp.status).toBe(400);
  });
});

describe('POST /api/v1/batch-scan (legacy)', () => {
  it('rejects empty videos array', async () => {
    const resp = await SELF.fetch(
      new Request('https://moderation-api.divine.video/api/v1/batch-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SERVICE_API_TOKEN}`,
        },
        body: JSON.stringify({ videos: [] }),
      })
    );
    expect(resp.status).toBe(400);
  });

  it('rejects batch over 100 videos', async () => {
    const videos = Array.from({ length: 101 }, (_, i) => ({
      sha256: (i.toString(16).padStart(2, '0')).repeat(32),
    }));
    const resp = await SELF.fetch(
      new Request('https://moderation-api.divine.video/api/v1/batch-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SERVICE_API_TOKEN}`,
        },
        body: JSON.stringify({ videos }),
      })
    );
    expect(resp.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run src/index.test.mjs`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.test.mjs
git commit -m "test: add legacy scan and batch-scan endpoint tests"
```

### Task 14: Run full suite and verify coverage

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Check coverage summary**

Run: `cd /Users/rabble/code/divine/divine-moderation-service-tests && npx vitest run --coverage`
Expected: Coverage output showing improvement across modules

- [ ] **Step 3: Final commit with any adjustments**

```bash
git commit --allow-empty -m "chore: test coverage improvement complete"
```

---

## Summary of New Test Coverage

| Module | Before | After |
|--------|--------|-------|
| Input validation (validation.mjs) | 0% | ~100% |
| API auth (auth-api.mjs) | 0% | ~100% |
| Admin auth (admin/auth.mjs) | 0% | ~80% |
| Offender tracker | 0% | ~90% |
| Reports system | 0% | ~90% |
| Text classifier | 0% | ~80% |
| Relay client (metadata) | 0% | ~60% |
| Relay poller (extractors) | 0% | ~40% |
| Admin moderate endpoint | 0% | ~70% |
| Admin verify-category endpoint | 0% | ~70% |
| Legacy scan endpoints | 0% | ~50% |

**Total new test files:** 8
**Total new test cases:** ~90+
**Estimated module coverage:** 37% → ~70%
