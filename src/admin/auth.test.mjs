// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for admin authentication middleware
// ABOUTME: Validates getAuthenticatedUser and requireAuth functions

import { describe, it, expect } from 'vitest';
import { getAuthenticatedUser, requireAuth } from './auth.mjs';

describe('Admin Auth', () => {
  describe('getAuthenticatedUser', () => {
    it('should return email from Cf-Access-Authenticated-User-Email header', () => {
      const request = new Request('https://example.com', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'user@divine.video' },
      });

      const result = getAuthenticatedUser(request);
      expect(result).toBe('user@divine.video');
    });

    it('should return null when header is missing', () => {
      const request = new Request('https://example.com');

      const result = getAuthenticatedUser(request);
      expect(result).toBeNull();
    });

    it('should return empty string when header is empty', () => {
      const request = new Request('https://example.com', {
        headers: { 'Cf-Access-Authenticated-User-Email': '' },
      });

      const result = getAuthenticatedUser(request);
      // Empty string header values are normalized; headers.get returns the value as-is
      expect(result).toBeFalsy();
    });
  });

  describe('requireAuth', () => {
    it('should allow access when ALLOW_DEV_ACCESS is true and no auth header', async () => {
      const request = new Request('https://example.com');
      const env = { ALLOW_DEV_ACCESS: 'true' };

      const result = await requireAuth(request, env);
      expect(result).toBeNull();
    });

    it('should return 401 when no auth and dev mode is off', async () => {
      const request = new Request('https://example.com');
      const env = { ALLOW_DEV_ACCESS: 'false' };

      const result = await requireAuth(request, env);
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(401);

      const body = await result.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when no auth and ALLOW_DEV_ACCESS is not set', async () => {
      const request = new Request('https://example.com');
      const env = {};

      const result = await requireAuth(request, env);
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(401);
    });

    it('should return null (allow) when user is authenticated via Zero Trust header', async () => {
      const request = new Request('https://example.com', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'admin@divine.video' },
      });
      const env = {};

      const result = await requireAuth(request, env);
      expect(result).toBeNull();
    });

    it('should return 401 response with JSON content type', async () => {
      const request = new Request('https://example.com');
      const env = {};

      const result = await requireAuth(request, env);
      expect(result.headers.get('Content-Type')).toBe('application/json');
    });
  });
});
