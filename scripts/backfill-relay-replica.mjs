// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Resumable local backfill for mirroring api.divine.video video/creator data into production D1
// ABOUTME: Scans sparse moderation rows with a stable cursor and writes relay_videos, relay_creators, and denormalized moderation fields

export const DEFAULT_BATCH_SIZE = 250;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_CHECKPOINT_FILE = 'tmp/backfill-relay-replica.checkpoint.json';
export const DEFAULT_DIVINE_API_BASE_URL = 'https://api.divine.video';
export const DEFAULT_D1_DATABASE_NAME = 'blossom-webhook-events';
export const DEFAULT_D1_DATABASE_ID = '829f06cf-294b-4491-8611-30fc53df2589';
export const DEFAULT_PERSIST_CHUNK_SIZE = 10;
export const DEFAULT_PERSIST_MAX_SQL_LENGTH = 60000;
export const DEFAULT_WRANGLER_FILE_SQL_THRESHOLD = Number.MAX_SAFE_INTEGER;

function isPresentValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function normalizePersistedTimestampValue(value) {
  if (!isPresentValue(value)) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function unique(values = []) {
  return [...new Set(values.filter((value) => isPresentValue(value)))];
}

function chunkArray(values = [], chunkSize = DEFAULT_PERSIST_CHUNK_SIZE) {
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const chunks = [];
  for (let index = 0; index < values.length; index += safeChunkSize) {
    chunks.push(values.slice(index, index + safeChunkSize));
  }
  return chunks;
}

function extractTagValue(tags = [], tagName) {
  for (const tag of tags) {
    if (tag?.[0] === tagName && isPresentValue(tag?.[1])) {
      return tag[1];
    }
  }
  return null;
}

function extractImetaUrl(tags = []) {
  for (const tag of tags) {
    if (tag?.[0] !== 'imeta') continue;
    for (let i = 1; i < tag.length; i++) {
      const part = tag[i];
      if (typeof part === 'string' && part.startsWith('url ')) {
        return part.slice(4).trim();
      }
    }
  }
  return null;
}

function compareCursor(a, b) {
  const aPriority = Number.isFinite(a?.priority_bucket) ? a.priority_bucket : 2;
  const bPriority = Number.isFinite(b?.priority_bucket) ? b.priority_bucket : 2;
  if (aPriority < bPriority) return -1;
  if (aPriority > bPriority) return 1;
  if (a.moderated_at < b.moderated_at) return -1;
  if (a.moderated_at > b.moderated_at) return 1;
  if (a.sha256 < b.sha256) return -1;
  if (a.sha256 > b.sha256) return 1;
  return 0;
}

function joinSqlStatements(statements = []) {
  const terminatedStatements = statements
    .filter(Boolean)
    .map((statement) => `${statement.replace(/;\s*$/, '')};`);
  return terminatedStatements.join('\n');
}

function buildRelayVideoUpsertSql(records = []) {
  if (!records.length) {
    return '';
  }
  const values = records.map((record) => `(
      ${sqlLiteral(record.sha256)}, ${sqlLiteral(record.event_id)}, ${sqlLiteral(record.stable_id)}, ${sqlLiteral(record.pubkey)},
      ${sqlLiteral(record.title)}, ${sqlLiteral(record.content)}, ${sqlLiteral(record.summary)}, ${sqlLiteral(record.video_url)},
      ${sqlLiteral(record.thumbnail_url)}, ${sqlLiteral(record.published_at)}, ${sqlLiteral(record.created_at)},
      ${sqlLiteral(record.author_name)}, ${sqlLiteral(record.author_avatar)}, ${sqlLiteral(record.raw_json)},
      ${sqlLiteral(record.synced_at)}, ${sqlLiteral(record.source_updated_at)}
    )`).join(',\n');

  return `
    INSERT INTO relay_videos (
      sha256, event_id, stable_id, pubkey, title, content, summary, video_url, thumbnail_url,
      published_at, created_at, author_name, author_avatar, raw_json, synced_at, source_updated_at
    ) VALUES
    ${values}
    ON CONFLICT(sha256) DO UPDATE SET
      event_id = excluded.event_id,
      stable_id = excluded.stable_id,
      pubkey = excluded.pubkey,
      title = excluded.title,
      content = excluded.content,
      summary = excluded.summary,
      video_url = excluded.video_url,
      thumbnail_url = excluded.thumbnail_url,
      published_at = excluded.published_at,
      created_at = excluded.created_at,
      author_name = excluded.author_name,
      author_avatar = excluded.author_avatar,
      raw_json = excluded.raw_json,
      synced_at = excluded.synced_at,
      source_updated_at = excluded.source_updated_at
  `.trim();
}

function buildRelayCreatorUpsertSql(records = []) {
  if (!records.length) {
    return '';
  }
  const values = records.map((record) => `(
      ${sqlLiteral(record.pubkey)}, ${sqlLiteral(record.display_name)}, ${sqlLiteral(record.username)},
      ${sqlLiteral(record.avatar_url)}, ${sqlLiteral(record.bio)}, ${sqlLiteral(record.website)},
      ${sqlLiteral(record.nip05)}, ${sqlLiteral(record.follower_count)}, ${sqlLiteral(record.following_count)},
      ${sqlLiteral(record.video_count)}, ${sqlLiteral(record.event_count)}, ${sqlLiteral(record.first_activity)},
      ${sqlLiteral(record.last_activity)}, ${sqlLiteral(record.raw_json)}, ${sqlLiteral(record.synced_at)}
    )`).join(',\n');

  return `
    INSERT INTO relay_creators (
      pubkey, display_name, username, avatar_url, bio, website, nip05,
      follower_count, following_count, video_count, event_count,
      first_activity, last_activity, raw_json, synced_at
    ) VALUES
    ${values}
    ON CONFLICT(pubkey) DO UPDATE SET
      display_name = excluded.display_name,
      username = excluded.username,
      avatar_url = excluded.avatar_url,
      bio = excluded.bio,
      website = excluded.website,
      nip05 = excluded.nip05,
      follower_count = excluded.follower_count,
      following_count = excluded.following_count,
      video_count = excluded.video_count,
      event_count = excluded.event_count,
      first_activity = excluded.first_activity,
      last_activity = excluded.last_activity,
      raw_json = excluded.raw_json,
      synced_at = excluded.synced_at
  `.trim();
}

function buildModerationRefreshSql(records = []) {
  if (!records.length) {
    return '';
  }
  const shas = records.map((record) => sqlLiteral(record.sha256)).join(', ');
  const fields = [
    'uploaded_by',
    'title',
    'author',
    'event_id',
    'content_url',
    'published_at'
  ];

  const assignments = fields.map((field) => {
    const clauses = records.map((record) => `WHEN ${sqlLiteral(record.sha256)} THEN ${sqlLiteral(record[field] ?? null)}`).join('\n        ');
    return `${field} = CASE sha256
        ${clauses}
        ELSE ${field}
      END`;
  }).join(',\n      ');

  return `
    UPDATE moderation_results
    SET ${assignments}
    WHERE sha256 IN (${shas})
  `.trim();
}

export function buildPersistReplicaSqlChunks({ videos = [], creators = [], moderationUpdates = [] } = {}, {
  chunkSize = DEFAULT_PERSIST_CHUNK_SIZE,
  maxSqlLength = DEFAULT_PERSIST_MAX_SQL_LENGTH
} = {}) {
  const creatorByPubkey = new Map(
    creators
      .filter((record) => isPresentValue(record?.pubkey))
      .map((record) => [record.pubkey, record])
  );
  const moderationBySha = new Map(
    moderationUpdates
      .filter((record) => isPresentValue(record?.sha256))
      .map((record) => [record.sha256, record])
  );

  function buildChunkSql(videoChunk) {
    const chunkCreators = [];
    const seenCreators = new Set();
    const chunkModerationUpdates = [];

    for (const videoRecord of videoChunk) {
      const creatorRecord = creatorByPubkey.get(videoRecord.pubkey);
      if (creatorRecord && !seenCreators.has(creatorRecord.pubkey)) {
        seenCreators.add(creatorRecord.pubkey);
        chunkCreators.push(creatorRecord);
      }

      const moderationRecord = moderationBySha.get(videoRecord.sha256);
      if (moderationRecord) {
        chunkModerationUpdates.push(moderationRecord);
      }
    }

    return joinSqlStatements([
      buildRelayVideoUpsertSql(videoChunk),
      buildRelayCreatorUpsertSql(chunkCreators),
      buildModerationRefreshSql(chunkModerationUpdates)
    ]);
  }

  const chunks = [];
  let currentChunk = [];

  for (const videoRecord of videos) {
    currentChunk.push(videoRecord);
    const candidateSql = buildChunkSql(currentChunk);
    if (
      currentChunk.length > 1
      && (currentChunk.length > chunkSize || candidateSql.length > maxSqlLength)
    ) {
      const overflowRecord = currentChunk.pop();
      chunks.push(buildChunkSql(currentChunk));
      currentChunk = [overflowRecord];
    }
  }

  if (currentChunk.length) {
    chunks.push(buildChunkSql(currentChunk));
  }

  return chunks;
}

export function buildWranglerExecuteArgs({
  databaseName,
  remote = true,
  wranglerBin = 'npx',
  sql,
  tempFile = null,
  fileSqlThreshold = DEFAULT_WRANGLER_FILE_SQL_THRESHOLD
} = {}) {
  const args = wranglerBin === 'npx'
    ? ['wrangler', 'd1', 'execute', databaseName]
    : ['d1', 'execute', databaseName];
  if (remote) {
    args.push('--remote');
  }
  args.push('--json');
  if (tempFile && typeof sql === 'string' && sql.length >= fileSqlThreshold) {
    args.push('--file', tempFile);
  } else {
    args.push('--command', sql);
  }
  return {
    command: wranglerBin,
    args
  };
}

export function buildSparseModerationRowsQuery({ cursor = null, limit = DEFAULT_BATCH_SIZE } = {}) {
  const safeLimit = Math.max(1, Math.floor(limit));
  const missingPredicate = `
    (
      uploaded_by IS NULL OR uploaded_by = '' OR
      title IS NULL OR title = '' OR
      author IS NULL OR author = '' OR
      event_id IS NULL OR event_id = '' OR
      content_url IS NULL OR content_url = '' OR
      published_at IS NULL OR published_at = ''
    )
  `.trim();
  const priorityExpression = `
    CASE
      WHEN action = 'REVIEW' AND reviewed_by IS NULL THEN 0
      WHEN action IN ('AGE_RESTRICTED', 'PERMANENT_BAN') AND reviewed_by IS NULL THEN 1
      ELSE 2
    END
  `.trim();
  const cursorPredicate = cursor
    ? `AND (
      ${priorityExpression} > ${Number.isFinite(cursor.priority_bucket) ? cursor.priority_bucket : 2}
      OR (
        ${priorityExpression} = ${Number.isFinite(cursor.priority_bucket) ? cursor.priority_bucket : 2}
        AND (
          moderated_at < ${sqlLiteral(cursor.moderated_at)}
          OR (moderated_at = ${sqlLiteral(cursor.moderated_at)} AND sha256 < ${sqlLiteral(cursor.sha256)})
        )
      )
    )`
    : '';

  const sql = `
    SELECT sha256, moderated_at, raw_response, uploaded_by, title, author, event_id, content_url, published_at,
           ${priorityExpression} AS priority_bucket
    FROM moderation_results
    WHERE ${missingPredicate}
    ${cursorPredicate}
    ORDER BY priority_bucket ASC, moderated_at DESC, sha256 DESC
    LIMIT ${safeLimit}
  `.trim();

  return { sql };
}

export async function loadCheckpoint(checkpointFile = DEFAULT_CHECKPOINT_FILE, { fsMod = null } = {}) {
  const fsApi = fsMod || await import('node:fs/promises');
  try {
    const data = await fsApi.readFile(checkpointFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveCheckpoint(checkpointFile = DEFAULT_CHECKPOINT_FILE, checkpoint, { fsMod = null } = {}) {
  const fsApi = fsMod || await import('node:fs/promises');
  const pathApi = await import('node:path');
  await fsApi.mkdir(pathApi.dirname(checkpointFile), { recursive: true });
  await fsApi.writeFile(checkpointFile, JSON.stringify(checkpoint, null, 2));
}

function initialStats() {
  return {
    scanned: 0,
    repaired: 0,
    unresolved: 0,
    failed: 0,
    batches: 0
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function buildRelayVideoMirrorRecord(sha256, payload, profile = null, syncedAt = new Date().toISOString()) {
  const event = payload?.event;
  if (!sha256 || !event) {
    return null;
  }

  const tags = event.tags || [];
  const stableId = extractTagValue(tags, 'd');
  const title = extractTagValue(tags, 'title');
  const publishedAt = normalizePersistedTimestampValue(extractTagValue(tags, 'published_at'));
  const videoUrl = extractImetaUrl(tags);

  return {
    sha256,
    event_id: event.id || null,
    stable_id: stableId || null,
    pubkey: event.pubkey || null,
    title: title || null,
    content: event.content || null,
    summary: extractTagValue(tags, 'summary'),
    video_url: videoUrl || null,
    thumbnail_url: payload?.thumbnail_url || null,
    published_at: publishedAt,
    created_at: normalizePersistedTimestampValue(event.created_at ?? null),
    author_name: payload?.stats?.author_name || profile?.display_name || profile?.name || null,
    author_avatar: payload?.stats?.author_avatar || profile?.picture || null,
    raw_json: JSON.stringify(payload),
    synced_at: syncedAt,
    source_updated_at: null
  };
}

export function buildRelayCreatorMirrorRecord(pubkey, profile = null, userData = null, socialData = null, syncedAt = new Date().toISOString()) {
  if (!pubkey) {
    return null;
  }

  const userProfile = userData?.profile || {};
  const userStats = userData?.stats || {};
  const userSocial = userData?.social || {};

  return {
    pubkey,
    display_name: profile?.display_name || userProfile.display_name || userProfile.name || null,
    username: profile?.name || userProfile.name || null,
    avatar_url: profile?.picture || userProfile.picture || null,
    bio: profile?.about || userProfile.about || null,
    website: profile?.website || userProfile.website || null,
    nip05: profile?.nip05 || userProfile.nip05 || null,
    follower_count: socialData?.follower_count ?? userSocial.follower_count ?? null,
    following_count: socialData?.following_count ?? userSocial.following_count ?? null,
    video_count: userStats.video_count ?? null,
    event_count: userStats.total_events ?? null,
    first_activity: userStats.first_activity ?? null,
    last_activity: userStats.last_activity ?? null,
    raw_json: JSON.stringify({ profile, user: userData, social: socialData }),
    synced_at: syncedAt
  };
}

export function buildModerationRefreshRecord(videoRecord, creatorRecord = null) {
  if (!videoRecord) {
    return null;
  }

  return {
    uploaded_by: videoRecord.pubkey || creatorRecord?.pubkey || null,
    title: videoRecord.title || null,
    author: videoRecord.author_name || creatorRecord?.display_name || creatorRecord?.username || null,
    event_id: videoRecord.event_id || null,
    content_url: videoRecord.video_url || null,
    published_at: normalizePersistedTimestampValue(videoRecord.published_at)
  };
}

export async function processReplicaBatch(rows, deps, options = {}) {
  const {
    fetchVideoBySha,
    fetchBulkUsers = async () => ({}),
    fetchBulkProfiles = async () => ({}),
    fetchUser = async () => null,
    fetchUserSocial = async () => null,
    persistReplicaBatch = null,
    upsertRelayVideo,
    upsertRelayCreator,
    refreshModerationResult,
    log = () => {}
  } = deps;
  const { concurrency = DEFAULT_CONCURRENCY, syncedAt = new Date().toISOString() } = options;

  const stats = {
    scanned: rows.length,
    repaired: 0,
    unresolved: 0,
    failed: 0
  };

  const fetched = await mapWithConcurrency(rows, concurrency, async (row) => {
    try {
      const payload = await fetchVideoBySha(row.sha256);
      return { row, payload };
    } catch (error) {
      return { row, error };
    }
  });

  const bulkProfiles = await fetchBulkProfiles(unique(
    fetched.map(({ payload }) => payload?.event?.pubkey || null)
  ));
  const bulkUsers = await fetchBulkUsers(unique(
    fetched.map(({ payload }) => payload?.event?.pubkey || null)
  ));
  const repairedRows = [];

  for (const item of fetched) {
    const { row, payload, error } = item;
    if (error) {
      stats.failed += 1;
      log(`[BACKFILL] fetch failed for ${row.sha256}: ${error.message}`);
      continue;
    }
    if (!payload?.event) {
      stats.unresolved += 1;
      continue;
    }

    const bulkUser = bulkUsers[payload.event.pubkey] || null;
    const profile = bulkUser?.profile || bulkProfiles[payload.event.pubkey] || null;
    const videoRecord = buildRelayVideoMirrorRecord(row.sha256, payload, profile, syncedAt);
    const [userData, socialData] = payload.event.pubkey
      ? bulkUser
        ? [bulkUser, bulkUser.social || null]
        : await Promise.all([
            fetchUser(payload.event.pubkey),
            fetchUserSocial(payload.event.pubkey)
          ])
      : [null, null];
    const creatorRecord = buildRelayCreatorMirrorRecord(payload.event.pubkey, profile, userData, socialData, syncedAt);
    const moderationRecord = {
      sha256: row.sha256,
      ...buildModerationRefreshRecord(videoRecord, creatorRecord)
    };

    repairedRows.push({
      videoRecord,
      creatorRecord,
      moderationRecord
    });
    stats.repaired += 1;
  }

  if (repairedRows.length) {
    if (typeof persistReplicaBatch === 'function') {
      await persistReplicaBatch({
        videos: repairedRows.map((entry) => entry.videoRecord),
        creators: repairedRows.map((entry) => entry.creatorRecord).filter(Boolean),
        moderationUpdates: repairedRows.map((entry) => entry.moderationRecord)
      });
    } else {
      for (const entry of repairedRows) {
        await upsertRelayVideo(entry.videoRecord);
        if (entry.creatorRecord) {
          await upsertRelayCreator(entry.creatorRecord);
        }
        await refreshModerationResult(entry.moderationRecord.sha256, entry.moderationRecord);
      }
    }
  }

  const lastRow = rows.at(-1) || null;
  const cursor = lastRow ? {
    priority_bucket: Number.isFinite(lastRow.priority_bucket) ? lastRow.priority_bucket : 2,
    moderated_at: lastRow.moderated_at,
    sha256: lastRow.sha256
  } : null;

  return { stats, cursor };
}

export async function runReplicaBackfill(options = {}, deps = {}) {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    concurrency = DEFAULT_CONCURRENCY,
    checkpointFile = DEFAULT_CHECKPOINT_FILE,
    maxBatches = Infinity,
    resume = true
  } = options;

  const {
    querySparseRows,
    loadCheckpoint: loadCheckpointFn = loadCheckpoint,
    saveCheckpoint: saveCheckpointFn = saveCheckpoint,
    log = console.log
  } = deps;

  if (typeof querySparseRows !== 'function') {
    throw new Error('querySparseRows dependency is required');
  }

  const checkpoint = resume ? await loadCheckpointFn(checkpointFile) : null;
  let cursor = checkpoint?.cursor || null;
  const totals = {
    ...initialStats(),
    ...(checkpoint?.stats || {})
  };
  let batches = 0;
  let completed = false;

  while (batches < maxBatches) {
    const rows = await querySparseRows({ cursor, limit: batchSize });
    if (!rows.length) {
      completed = true;
      break;
    }

    batches += 1;
    const batchResult = await processReplicaBatch(rows, deps, { concurrency });
    totals.scanned += batchResult.stats.scanned;
    totals.repaired += batchResult.stats.repaired;
    totals.unresolved += batchResult.stats.unresolved;
    totals.failed += batchResult.stats.failed;
    totals.batches += 1;
    cursor = batchResult.cursor;

    await saveCheckpointFn(checkpointFile, {
      cursor,
      stats: totals
    });
    log(`[BACKFILL] batch=${totals.batches} scanned=${totals.scanned} repaired=${totals.repaired} unresolved=${totals.unresolved} failed=${totals.failed}`);
  }

  return {
    completed,
    cursor,
    stats: totals
  };
}

function parseWranglerJson(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

export function parseWranglerWhoamiAccountId(output = '') {
  const match = String(output).match(/\b([a-f0-9]{32})\b/i);
  return match ? match[1].toLowerCase() : null;
}

export function createCloudflareApiD1Client({
  accountId,
  databaseId,
  apiToken,
  fetchImpl = fetch
} = {}) {
  if (!accountId || !databaseId || !apiToken) {
    throw new Error('Cloudflare API D1 client requires accountId, databaseId, and apiToken');
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function executeSql(sql) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.success) {
      throw new Error(`Cloudflare D1 API request failed (${response.status || 'unknown'}): ${JSON.stringify(payload)}`);
    }
    return Array.isArray(payload.result) ? payload.result[0] : payload.result;
  }

  return {
    async querySparseRows({ cursor, limit }) {
      const { sql } = buildSparseModerationRowsQuery({ cursor, limit });
      const result = await executeSql(sql);
      return result?.results || [];
    },
    async persistReplicaBatch(records) {
      const chunks = buildPersistReplicaSqlChunks(records);
      for (const sql of chunks) {
        await executeSql(sql);
      }
    },
    async upsertRelayVideo(record) {
      await executeSql(buildRelayVideoUpsertSql([record]));
    },
    async upsertRelayCreator(record) {
      await executeSql(buildRelayCreatorUpsertSql([record]));
    },
    async refreshModerationResult(sha256, record) {
      await executeSql(buildModerationRefreshSql([{ sha256, ...record }]));
    }
  };
}

async function loadWranglerOAuthToken() {
  const fsApi = await import('node:fs/promises');
  const osApi = await import('node:os');
  const pathApi = await import('node:path');
  const configPath = pathApi.join(osApi.homedir(), 'Library/Preferences/.wrangler/config/default.toml');
  const content = await fsApi.readFile(configPath, 'utf8');
  const match = content.match(/^oauth_token = "([^"]+)"/m);
  return match ? match[1] : null;
}

async function loadWranglerAccountId({ wranglerBin = 'npx' } = {}) {
  const { execFile } = await import('node:child_process');
  const command = wranglerBin;
  const args = wranglerBin === 'npx' ? ['wrangler', 'whoami'] : ['whoami'];
  const stdout = await new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, out, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(out);
    });
  });
  return parseWranglerWhoamiAccountId(stdout);
}

async function createWranglerD1Client({
  databaseName = DEFAULT_D1_DATABASE_NAME,
  remote = true,
  wranglerBin = 'npx',
  fileSqlThreshold = DEFAULT_WRANGLER_FILE_SQL_THRESHOLD
} = {}) {
  const { execFile } = await import('node:child_process');

  async function executeSql(sql) {
    const invocation = buildWranglerExecuteArgs({
      databaseName,
      remote,
      wranglerBin,
      sql,
      fileSqlThreshold
    });

    const result = await new Promise((resolve, reject) => {
      execFile(invocation.command, invocation.args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      });
    });

    return parseWranglerJson(result);
  }

  return {
    async querySparseRows({ cursor, limit }) {
      const { sql } = buildSparseModerationRowsQuery({ cursor, limit });
      const result = await executeSql(sql);
      return result.results || [];
    },
    async persistReplicaBatch(records) {
      const chunks = buildPersistReplicaSqlChunks(records);
      for (const sql of chunks) {
        await executeSql(sql);
      }
    },
    async upsertRelayVideo(record) {
      const sql = `
        INSERT INTO relay_videos (
          sha256, event_id, stable_id, pubkey, title, content, summary, video_url, thumbnail_url,
          published_at, created_at, author_name, author_avatar, raw_json, synced_at, source_updated_at
        ) VALUES (
          ${sqlLiteral(record.sha256)}, ${sqlLiteral(record.event_id)}, ${sqlLiteral(record.stable_id)}, ${sqlLiteral(record.pubkey)},
          ${sqlLiteral(record.title)}, ${sqlLiteral(record.content)}, ${sqlLiteral(record.summary)}, ${sqlLiteral(record.video_url)},
          ${sqlLiteral(record.thumbnail_url)}, ${sqlLiteral(record.published_at)}, ${sqlLiteral(record.created_at)},
          ${sqlLiteral(record.author_name)}, ${sqlLiteral(record.author_avatar)}, ${sqlLiteral(record.raw_json)},
          ${sqlLiteral(record.synced_at)}, ${sqlLiteral(record.source_updated_at)}
        )
        ON CONFLICT(sha256) DO UPDATE SET
          event_id = excluded.event_id,
          stable_id = excluded.stable_id,
          pubkey = excluded.pubkey,
          title = excluded.title,
          content = excluded.content,
          summary = excluded.summary,
          video_url = excluded.video_url,
          thumbnail_url = excluded.thumbnail_url,
          published_at = excluded.published_at,
          created_at = excluded.created_at,
          author_name = excluded.author_name,
          author_avatar = excluded.author_avatar,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at,
          source_updated_at = excluded.source_updated_at
      `.trim();
      await executeSql(sql);
    },
    async upsertRelayCreator(record) {
      const sql = `
        INSERT INTO relay_creators (
          pubkey, display_name, username, avatar_url, bio, website, nip05,
          follower_count, following_count, video_count, event_count,
          first_activity, last_activity, raw_json, synced_at
        ) VALUES (
          ${sqlLiteral(record.pubkey)}, ${sqlLiteral(record.display_name)}, ${sqlLiteral(record.username)},
          ${sqlLiteral(record.avatar_url)}, ${sqlLiteral(record.bio)}, ${sqlLiteral(record.website)},
          ${sqlLiteral(record.nip05)}, ${sqlLiteral(record.follower_count)}, ${sqlLiteral(record.following_count)},
          ${sqlLiteral(record.video_count)}, ${sqlLiteral(record.event_count)}, ${sqlLiteral(record.first_activity)},
          ${sqlLiteral(record.last_activity)}, ${sqlLiteral(record.raw_json)}, ${sqlLiteral(record.synced_at)}
        )
        ON CONFLICT(pubkey) DO UPDATE SET
          display_name = excluded.display_name,
          username = excluded.username,
          avatar_url = excluded.avatar_url,
          bio = excluded.bio,
          website = excluded.website,
          nip05 = excluded.nip05,
          follower_count = excluded.follower_count,
          following_count = excluded.following_count,
          video_count = excluded.video_count,
          event_count = excluded.event_count,
          first_activity = excluded.first_activity,
          last_activity = excluded.last_activity,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at
      `.trim();
      await executeSql(sql);
    },
    async refreshModerationResult(sha256, record) {
      const sql = `
        UPDATE moderation_results
        SET uploaded_by = ${sqlLiteral(record.uploaded_by)},
            title = ${sqlLiteral(record.title)},
            author = ${sqlLiteral(record.author)},
            event_id = ${sqlLiteral(record.event_id)},
            content_url = ${sqlLiteral(record.content_url)},
            published_at = ${sqlLiteral(record.published_at)}
        WHERE sha256 = ${sqlLiteral(sha256)}
      `.trim();
      await executeSql(sql);
    }
  };
}

async function createPreferredD1Client({
  databaseName = DEFAULT_D1_DATABASE_NAME,
  databaseId = DEFAULT_D1_DATABASE_ID,
  remote = true,
  wranglerBin = 'npx',
  fileSqlThreshold = DEFAULT_WRANGLER_FILE_SQL_THRESHOLD
} = {}) {
  if (remote && databaseId) {
    try {
      const [apiToken, accountId] = await Promise.all([
        loadWranglerOAuthToken(),
        loadWranglerAccountId({ wranglerBin })
      ]);
      if (apiToken && accountId) {
        return createCloudflareApiD1Client({
          accountId,
          databaseId,
          apiToken
        });
      }
    } catch {
      // Fall back to wrangler subprocess mode if OAuth/config resolution fails.
    }
  }

  return createWranglerD1Client({
    databaseName,
    remote,
    wranglerBin,
    fileSqlThreshold
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers || {})
    }
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function parseArgs(argv = []) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    checkpointFile: DEFAULT_CHECKPOINT_FILE,
    maxBatches: Infinity,
    resume: true,
    remote: true,
    databaseName: DEFAULT_D1_DATABASE_NAME,
    databaseId: DEFAULT_D1_DATABASE_ID,
    apiBaseUrl: DEFAULT_DIVINE_API_BASE_URL
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--batch-size' && next) {
      options.batchSize = Number(next);
      index += 1;
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number(next);
      index += 1;
    } else if (arg === '--checkpoint' && next) {
      options.checkpointFile = next;
      index += 1;
    } else if (arg === '--max-batches' && next) {
      options.maxBatches = Number(next);
      index += 1;
    } else if (arg === '--database' && next) {
      options.databaseName = next;
      index += 1;
    } else if (arg === '--database-id' && next) {
      options.databaseId = next;
      index += 1;
    } else if (arg === '--api-base-url' && next) {
      options.apiBaseUrl = next;
      index += 1;
    } else if (arg === '--no-resume') {
      options.resume = false;
    } else if (arg === '--local') {
      options.remote = false;
    }
  }

  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const d1 = await createPreferredD1Client({
    databaseName: options.databaseName,
    databaseId: options.databaseId,
    remote: options.remote
  });
  const apiBaseUrl = options.apiBaseUrl;

  const result = await runReplicaBackfill(options, {
    ...d1,
    async fetchVideoBySha(sha256) {
      return fetchJson(`${apiBaseUrl}/api/videos/${encodeURIComponent(sha256)}`);
    },
    async fetchBulkProfiles(pubkeys) {
      if (!pubkeys.length) {
        return {};
      }
      const data = await fetchJson(`${apiBaseUrl}/api/users/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkeys })
      });
      const users = Array.isArray(data?.users) ? data.users : [];
      return Object.fromEntries(users.map((user) => [user.pubkey, user.profile || null]));
    },
    async fetchBulkUsers(pubkeys) {
      if (!pubkeys.length) {
        return {};
      }
      const data = await fetchJson(`${apiBaseUrl}/api/users/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkeys })
      });
      const users = Array.isArray(data?.users) ? data.users : [];
      return Object.fromEntries(users.map((user) => [user.pubkey, user]));
    },
    async fetchUser(pubkey) {
      return fetchJson(`${apiBaseUrl}/api/users/${encodeURIComponent(pubkey)}`);
    },
    async fetchUserSocial(pubkey) {
      return fetchJson(`${apiBaseUrl}/api/users/${encodeURIComponent(pubkey)}/social`);
    },
    log: console.log
  });

  console.log('[BACKFILL] Complete:', JSON.stringify(result, null, 2));
}

const directRun = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && import.meta.url.endsWith(`/scripts/${process.argv[1].split(/[\\/]/).pop()}`);

if (directRun) {
  main().catch((error) => {
    console.error('[BACKFILL] Fatal:', error);
    process.exitCode = 1;
  });
}
