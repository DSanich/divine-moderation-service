// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Backfill script to classify existing videos that lack classifier data (AI detection, scene labels)
// ABOUTME: Fetches events from relay, checks for existing classifier data, and queues classification

import { WebSocket } from 'ws';
import fs from 'fs';

const CHECKPOINT_FILE = '.backfill-classification-checkpoint.json';

function getApiToken(options = {}) {
  return options.apiToken || process.env.MODERATION_API_TOKEN || process.env.SERVICE_API_TOKEN || null;
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[CHECKPOINT] Failed to load checkpoint:', error.message);
  }
  return null;
}

function saveCheckpoint(checkpoint) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    console.log(`[CHECKPOINT] Saved progress: until=${new Date(checkpoint.currentUntil * 1000).toISOString()}, classified=${checkpoint.stats.classified}`);
  } catch (error) {
    console.error('[CHECKPOINT] Failed to save checkpoint:', error.message);
  }
}

function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE);
      console.log('[CHECKPOINT] Cleared checkpoint file');
    }
  } catch (error) {
    console.error('[CHECKPOINT] Failed to clear checkpoint:', error.message);
  }
}

/**
 * Extract SHA256 from imeta tag parameters
 */
function extractSha256FromImeta(event) {
  if (!event || !event.tags) return null;

  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      for (let i = 1; i < tag.length; i++) {
        const param = tag[i];
        if (param && param.startsWith('x ')) {
          return param.substring(2).trim();
        }
      }
    }
  }

  return null;
}

/**
 * Fetch kind 34236 events from relay with pagination support
 */
async function fetchEventsFromRelay(relayUrl, options = {}) {
  const { limit = 100, since = null, until = null } = options;

  return new Promise((resolve, reject) => {
    const events = [];
    let ws;

    const timeout = setTimeout(() => {
      if (ws) ws.close();
      reject(new Error('WebSocket timeout'));
    }, 30000);

    try {
      ws = new WebSocket(relayUrl);

      ws.on('open', () => {
        const subscriptionId = Math.random().toString(36).substring(7);
        const filter = {
          kinds: [34236],
          limit
        };

        if (since !== null) filter.since = since;
        if (until !== null) filter.until = until;

        const reqMessage = JSON.stringify(['REQ', subscriptionId, filter]);

        const timeRange = since || until
          ? ` (${since ? `since=${new Date(since * 1000).toISOString()}` : ''} ${until ? `until=${new Date(until * 1000).toISOString()}` : ''})`
          : '';
        console.log(`[CLASSIFY] Requesting ${limit} kind 34236 events from ${relayUrl}${timeRange}`);
        ws.send(reqMessage);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg[0] === 'EVENT') {
            const event = msg[2];
            events.push(event);
          }

          if (msg[0] === 'EOSE') {
            console.log(`[CLASSIFY] Received ${events.length} events`);
            clearTimeout(timeout);
            ws.close();
            resolve(events);
          }
        } catch (err) {
          console.error('[CLASSIFY] Failed to parse message:', err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * Check if video has classifier data
 */
async function checkClassified(sha256, workerUrl, apiToken) {
  const response = await fetch(`${workerUrl}/api/v1/classifier/${sha256}`, {
    headers: {
      'Authorization': `Bearer ${apiToken}`
    }
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return true;
}

/**
 * Classify a video via the API
 */
async function classifyVideo(sha256, workerUrl, apiToken) {
  const response = await fetch(`${workerUrl}/api/v1/classify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    },
    body: JSON.stringify({ sha256 })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }

  return await response.json();
}

/**
 * Main backfill function
 */
async function backfillClassification(options = {}) {
  const {
    relayUrl = 'wss://relay.divine.video',
    workerUrl = 'https://moderation-api.divine.video',
    batchSize = 100,
    maxTotal = null,
    since = null,
    until = null,
    dryRun = false,
    resume = true,
    countOnly = false,
    concurrency = 3
  } = options;
  const apiToken = getApiToken(options);

  if (!apiToken) {
    throw new Error('Missing API token. Set SERVICE_API_TOKEN or MODERATION_API_TOKEN, or pass --token.');
  }

  let checkpoint = null;
  if (resume) {
    checkpoint = loadCheckpoint();
    if (checkpoint) {
      console.log('[CHECKPOINT] Found existing checkpoint, resuming from previous run');
      console.log(`[CHECKPOINT] Previous progress: classified=${checkpoint.stats.classified}, skipped=${checkpoint.stats.alreadyClassified}`);
      console.log(`[CHECKPOINT] Resuming from: ${new Date(checkpoint.currentUntil * 1000).toISOString()}`);
      console.log('');
    }
  }

  console.log(`[CLASSIFY] Starting classification backfill`);
  console.log(`[CLASSIFY] Relay: ${relayUrl}`);
  console.log(`[CLASSIFY] Worker: ${workerUrl}`);
  console.log(`[CLASSIFY] Batch: ${batchSize}, Max: ${maxTotal || 'unlimited'}, Dry-run: ${dryRun}, Concurrency: ${concurrency}`);
  if (since) console.log(`[CLASSIFY] Since: ${new Date(since * 1000).toISOString()}`);
  if (until) console.log(`[CLASSIFY] Until: ${new Date(until * 1000).toISOString()}`);
  console.log('');

  const stats = checkpoint ? checkpoint.stats : {
    totalEvents: 0,
    totalVideos: 0,
    alreadyClassified: 0,
    needsClassification: 0,
    classified: 0,
    failed: 0,
    batches: 0
  };

  let currentUntil = checkpoint ? checkpoint.currentUntil : until;
  let hasMore = true;

  while (hasMore) {
    stats.batches++;
    console.log(`[CLASSIFY] === Batch ${stats.batches} ===`);

    const events = await fetchEventsFromRelay(relayUrl, {
      limit: batchSize,
      since,
      until: currentUntil
    });

    if (events.length === 0) {
      console.log('[CLASSIFY] No more events found');
      hasMore = false;
      break;
    }

    stats.totalEvents += events.length;

    // Extract SHA256s (deduplicate within batch)
    const seen = new Set();
    const videoData = [];
    for (const event of events) {
      const sha256 = extractSha256FromImeta(event);
      if (!sha256) continue;
      if (seen.has(sha256)) continue;
      seen.add(sha256);

      videoData.push({
        eventId: event.id,
        sha256,
        createdAt: event.created_at
      });
    }

    stats.totalVideos += videoData.length;
    console.log(`[CLASSIFY] Extracted ${videoData.length} unique videos from ${events.length} events`);

    if (!countOnly) {
      // Process in chunks for concurrency
      for (let i = 0; i < videoData.length; i += concurrency) {
        const chunk = videoData.slice(i, i + concurrency);

        const results = await Promise.allSettled(chunk.map(async (video) => {
          const isClassified = await checkClassified(video.sha256, workerUrl, apiToken);

          if (isClassified) {
            stats.alreadyClassified++;
            console.log(`  [skip] ${video.sha256.substring(0, 16)}... already classified`);
            return 'skipped';
          }

          stats.needsClassification++;

          if (dryRun) {
            console.log(`  [need] ${video.sha256.substring(0, 16)}... needs classification (dry-run)`);
            return 'dry-run';
          }

          const result = await classifyVideo(video.sha256, workerUrl, apiToken);
          stats.classified++;
          const status = result.status || 'classified';
          console.log(`  [done] ${video.sha256.substring(0, 16)}... ${status}`);
          return 'classified';
        }));

        // Count failures
        for (const r of results) {
          if (r.status === 'rejected') {
            stats.failed++;
            console.error(`  [fail] ${r.reason?.message || r.reason}`);
          }
        }

        // Rate limit between chunks (VLM API calls are expensive)
        if (!dryRun && i + concurrency < videoData.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } else {
      console.log(`[CLASSIFY] Count-only mode: skipping classification check`);
    }

    // Check limits
    if (maxTotal && stats.totalVideos >= maxTotal) {
      console.log(`[CLASSIFY] Reached max total (${maxTotal})`);
      hasMore = false;
      break;
    }

    // Update cursor
    if (videoData.length > 0) {
      const oldestTimestamp = Math.min(...videoData.map(v => v.createdAt));
      currentUntil = oldestTimestamp - 1;
      console.log(`[CLASSIFY] Next batch until ${new Date(currentUntil * 1000).toISOString()}`);

      saveCheckpoint({ currentUntil, stats, timestamp: Date.now() });
    }

    if (events.length < batchSize) {
      console.log('[CLASSIFY] Reached end of events');
      hasMore = false;
    }

    console.log('');
  }

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('[CLASSIFY] Final Summary:');
  console.log(`  Batches processed:     ${stats.batches}`);
  console.log(`  Total events:          ${stats.totalEvents}`);
  console.log(`  Total unique videos:   ${stats.totalVideos}`);
  console.log(`  Already classified:    ${stats.alreadyClassified}`);
  console.log(`  Needs classification:  ${stats.needsClassification}`);
  console.log(`  Classified this run:   ${stats.classified}`);
  console.log(`  Failed:                ${stats.failed}`);
  console.log('='.repeat(60));

  if (hasMore === false) {
    clearCheckpoint();
  }

  return stats;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--max-total' && args[i + 1]) {
      options.maxTotal = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--since' && args[i + 1]) {
      const val = args[i + 1];
      options.since = val.includes('-') ? Math.floor(new Date(val).getTime() / 1000) : parseInt(val, 10);
      i++;
    } else if (args[i] === '--until' && args[i + 1]) {
      const val = args[i + 1];
      options.until = val.includes('-') ? Math.floor(new Date(val).getTime() / 1000) : parseInt(val, 10);
      i++;
    } else if (args[i] === '--relay' && args[i + 1]) {
      options.relayUrl = args[i + 1];
      i++;
    } else if (args[i] === '--worker' && args[i + 1]) {
      options.workerUrl = args[i + 1];
      i++;
    } else if (args[i] === '--token' && args[i + 1]) {
      options.apiToken = args[i + 1];
      i++;
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      options.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--count-only') {
      options.countOnly = true;
    } else if (args[i] === '--no-resume') {
      options.resume = false;
    } else if (args[i] === '--clear-checkpoint') {
      clearCheckpoint();
      console.log('Checkpoint cleared.');
      process.exit(0);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/backfill-classification.mjs [OPTIONS]

Backfill AI detection / scene classification for videos that have been
moderated but lack classifier data (showing "AI scan pending").

Options:
  --batch-size <n>      Events to fetch per relay batch (default: 100)
  --max-total <n>       Maximum total videos to process (default: unlimited)
  --since <date>        Only events after this date (ISO or unix timestamp)
  --until <date>        Only events before this date (ISO or unix timestamp)
  --relay <url>         Nostr relay URL (default: wss://relay.divine.video)
  --worker <url>        API URL (default: https://moderation-api.divine.video)
  --token <token>       Bearer token for API auth
  --concurrency <n>     Concurrent classify requests (default: 3)
  --dry-run             Check what needs classification without running it
  --count-only          Just count videos, skip classification checks
  --no-resume           Start fresh, ignore saved checkpoint
  --clear-checkpoint    Delete checkpoint and exit
  --help, -h            Show this help

Examples:
  # Dry-run: see how many videos since Nov 12 need classification
  node scripts/backfill-classification.mjs --since 2025-11-12 --dry-run --token \$TOKEN

  # Classify all videos since Nov 12, 2025
  SERVICE_API_TOKEN=... node scripts/backfill-classification.mjs --since 2025-11-12

  # Process first 50 videos only
  node scripts/backfill-classification.mjs --since 2025-11-12 --max-total 50 --token \$TOKEN

  # Resume after interruption (automatic)
  node scripts/backfill-classification.mjs --since 2025-11-12 --token \$TOKEN
      `);
      process.exit(0);
    }
  }

  backfillClassification(options)
    .then(() => {
      console.log('[CLASSIFY] Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[CLASSIFY] Fatal error:', error);
      process.exit(1);
    });
}

export { backfillClassification, fetchEventsFromRelay, extractSha256FromImeta };
