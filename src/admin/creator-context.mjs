// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Enriches admin moderation payloads with creator profile and social context
// ABOUTME: Merges local moderation history with public Funnelcake API user data

const FUNNEL_BASE_URL = 'https://api.divine.video';

function mapLocalStats(stats) {
  if (!stats) {
    return null;
  }

  return {
    totalScanned: stats.total_scanned || 0,
    flagged: stats.flagged_count || 0,
    restricted: stats.restricted_count || 0,
    banned: stats.banned_count || 0,
    review: stats.review_count || 0,
    riskLevel: stats.risk_level || 'normal',
  };
}

function mapEnforcement(enforcement, pubkey) {
  return {
    pubkey,
    approvalRequired: Boolean(enforcement?.approval_required),
    relayBanned: Boolean(enforcement?.relay_banned),
  };
}

function mapProfileName(userData) {
  return userData?.profile?.display_name || userData?.profile?.name || null;
}

export async function buildCreatorContext(input, { fetchFn = fetch, includeRemote = true } = {}) {
  const { pubkey, uploaderStats = null, uploaderEnforcement = null } = input || {};
  if (!pubkey) {
    return null;
  }

  const creatorContext = {
    name: null,
    pubkey,
    profileUrl: `https://divine.video/profile/${pubkey}`,
    avatarUrl: null,
    stats: mapLocalStats(uploaderStats),
    social: null,
    enforcement: mapEnforcement(uploaderEnforcement, pubkey),
  };

  if (!includeRemote) {
    return creatorContext;
  }

  try {
    const [userResponse, socialResponse] = await Promise.all([
      fetchFn(`${FUNNEL_BASE_URL}/api/users/${pubkey}`),
      fetchFn(`${FUNNEL_BASE_URL}/api/users/${pubkey}/social`),
    ]);

    const userData = userResponse?.ok ? await userResponse.json() : null;
    const socialData = socialResponse?.ok ? await socialResponse.json() : null;

    creatorContext.name = mapProfileName(userData);
    creatorContext.avatarUrl = userData?.profile?.picture || null;
    creatorContext.social = (userData || socialData)
      ? {
          videoCount: userData?.stats?.video_count ?? null,
          totalEvents: userData?.stats?.total_events ?? null,
          followerCount: socialData?.follower_count ?? userData?.social?.follower_count ?? null,
          followingCount: socialData?.following_count ?? userData?.social?.following_count ?? null,
          firstActivity: userData?.stats?.first_activity ?? null,
          lastActivity: userData?.stats?.last_activity ?? null,
        }
      : null;
  } catch {
    // Local moderation context is still useful even when Funnelcake is unavailable.
  }

  return creatorContext;
}
