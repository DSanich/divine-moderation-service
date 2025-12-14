// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Admin authentication middleware using Cloudflare Zero Trust
// ABOUTME: Validates CF Access JWT headers - all auth handled at edge by Zero Trust

/**
 * Get authenticated user email from Cloudflare Access headers
 * Zero Trust sets this header after successful authentication
 */
export function getAuthenticatedUser(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email');
}

/**
 * Middleware to check authentication via Cloudflare Zero Trust
 * Returns null if authenticated, Response if not authenticated
 *
 * Zero Trust handles authorization at the edge - if a request reaches
 * the Worker with CF Access headers, the user is already authorized.
 */
export async function requireAuth(request, env) {
  const userEmail = getAuthenticatedUser(request);

  // In development without Zero Trust, allow if explicitly configured
  if (!userEmail && env.ALLOW_DEV_ACCESS === 'true') {
    console.log('[AUTH] Development mode - bypassing Zero Trust check');
    return null;
  }

  if (!userEmail) {
    console.log('[AUTH] No Cf-Access-Authenticated-User-Email header - not authenticated via Zero Trust');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Zero Trust already verified this user is authorized
  // No need for additional email domain check here
  console.log(`[AUTH] Authenticated user: ${userEmail}`);
  return null; // Authenticated
}

// Legacy exports for backwards compatibility during transition
// These can be removed once login UI is removed
export async function verifyPassword() { return false; }
export async function createSession() { return null; }
export async function verifySession() { return false; }
export async function deleteSession() {}
export function getTokenFromCookie() { return null; }
