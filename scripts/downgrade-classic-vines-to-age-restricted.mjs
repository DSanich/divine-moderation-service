#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Discovers legacy Vine imports and downgrades eligible machine-applied moderation to AGE_RESTRICTED
// ABOUTME: Skips rows with human review signals and supports preview/execute operational runs

import fs from 'fs';
import path from 'path';
import { extractMediaShaFromEvent } from '../src/validation.mjs';
import { isOriginalVine, parseVideoEventMetadata } from '../src/nostr/relay-client.mjs';

const DEFAULT_RELAY_URL = 'wss://relay.divine.video';
const DEFAULT_WORKER_URL = 'https://moderation-api.divine.video';
const DEFAULT_ADMIN_ORIGIN = 'https://moderation.admin.divine.video';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 5;
const CHECKPOINT_FILE = '.classic-vine-age-restricted-checkpoint.json';
const REPORT_FILE = '.classic-vine-age-restricted-report.json';
const DOWNGRADE_REASON = 'classic-vine-downgrade: machine-applied legacy Vine restriction downgraded to age-restricted';
const DOWNGRADE_SOURCE = 'classic-vine-downgrade-script';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getApiToken(options = {}) {
  return options.apiToken || process.env.MODERATION_API_TOKEN || process.env.SERVICE_API_TOKEN || null;
}

function getAdminOrigin(options = {}) {
  return options.adminOrigin || process.env.MODERATION_ADMIN_ORIGIN || null;
}

function getCfAccessCookie(options = {}) {
  return options.cfAccessCookie || process.env.CF_ACCESS_COOKIE || null;
}

function parseUnixTimestamp(value) {
  if (value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return null;
  return args[index + 1];
}

function hasAdminSessionAuth(options = {}) {
  return Boolean(options.adminOrigin && options.cfAccessCookie);
}

export function buildAgeRestrictedUpdate(sha256) {
  return {
    sha256,
    action: 'AGE_RESTRICTED',
    reason: DOWNGRADE_REASON,
    source: DOWNGRADE_SOURCE
  };
}

export function classifyDecisionForDowngrade(decision) {
  if (!decision) {
    return { eligible: false, reason: 'no-decision' };
  }

  if (decision.reviewed_by) {
    return { eligible: false, reason: 'human-reviewed' };
  }

  if (decision.review_notes) {
    return { eligible: false, reason: 'review-notes-present' };
  }

  if (decision.action === 'SAFE') {
    return { eligible: false, reason: 'already-safe' };
  }

  if (decision.action === 'AGE_RESTRICTED') {
    return { eligible: false, reason: 'already-age-restricted' };
  }

  return { eligible: true, reason: 'eligible-machine-restriction' };
}

export function extractClassicVineCandidateFromEvent(event) {
  const sha256 = extractMediaShaFromEvent(event);
  if (!sha256) return null;

  const nostrContext = parseVideoEventMetadata(event);
  if (!isOriginalVine(nostrContext)) return null;

  return {
    sha256,
    eventId: event?.id || null,
    nostrContext
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const mode = argv.includes('--execute') ? 'execute' : 'preview';
  const relayUrl = getArgValue(argv, '--relay') || DEFAULT_RELAY_URL;
  const workerUrl = getArgValue(argv, '--worker') || DEFAULT_WORKER_URL;
  const apiToken = getArgValue(argv, '--token') || getApiToken();
  const adminOrigin = getArgValue(argv, '--admin-origin') || getAdminOrigin();
  const cfAccessCookie = getArgValue(argv, '--cf-access-cookie') || getCfAccessCookie();
  const inputPath = getArgValue(argv, '--input');
  const checkpointPath = getArgValue(argv, '--checkpoint') || CHECKPOINT_FILE;
  const reportPath = getArgValue(argv, '--report') || REPORT_FILE;
  const batchSize = Number.parseInt(getArgValue(argv, '--batch-size') || String(DEFAULT_BATCH_SIZE), 10);
  const concurrency = Number.parseInt(getArgValue(argv, '--concurrency') || String(DEFAULT_CONCURRENCY), 10);
  const maxTotal = parseUnixTimestamp(getArgValue(argv, '--max-total'));
  const since = parseUnixTimestamp(getArgValue(argv, '--since'));
  const until = parseUnixTimestamp(getArgValue(argv, '--until'));
  const resume = !argv.includes('--no-resume');

  return {
    mode,
    relayUrl,
    workerUrl,
    apiToken,
    adminOrigin: adminOrigin ? adminOrigin.replace(/\/$/, '') : null,
    cfAccessCookie,
    inputPath,
    checkpointPath,
    reportPath,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY,
    maxTotal: Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : null,
    since,
    until,
    resume
  };
}

export function loadCheckpoint(checkpointPath) {
  try {
    if (!checkpointPath || !fs.existsSync(checkpointPath)) return null;
    return readJsonFile(checkpointPath);
  } catch (error) {
    console.error('[DOWNGRADE] Failed to load checkpoint:', error.message);
    return null;
  }
}

export function saveCheckpoint(checkpointPath, checkpoint) {
  try {
    if (!checkpointPath) return;
    writeJsonFile(checkpointPath, checkpoint);
  } catch (error) {
    console.error('[DOWNGRADE] Failed to save checkpoint:', error.message);
  }
}

function buildRequestHeaders(options = {}) {
  if (hasAdminSessionAuth(options)) {
    return {
      'Cookie': `CF_Authorization=${options.cfAccessCookie}`,
      'Content-Type': 'application/json'
    };
  }

  return {
    'Authorization': `Bearer ${options.apiToken}`,
    'Content-Type': 'application/json'
  };
}

function buildDecisionLookupUrl(sha256, options = {}) {
  if (hasAdminSessionAuth(options)) {
    return `${options.adminOrigin || DEFAULT_ADMIN_ORIGIN}/admin/api/video/${sha256}`;
  }

  return `${options.workerUrl}/api/v1/decisions/${sha256}`;
}

function buildAgeRestrictedUpdateRequest(sha256, options = {}) {
  if (hasAdminSessionAuth(options)) {
    return {
      method: 'POST',
      headers: buildRequestHeaders(options),
      body: JSON.stringify({
        action: 'AGE_RESTRICTED',
        reason: DOWNGRADE_REASON
      })
    };
  }

  return {
    method: 'POST',
    headers: buildRequestHeaders(options),
    body: JSON.stringify(buildAgeRestrictedUpdate(sha256))
  };
}

async function fetchRelayEvents(relayUrl, options = {}, deps = {}) {
  const WebSocketImpl = deps.WebSocket || globalThis.WebSocket;
  if (!WebSocketImpl) {
    throw new Error('Global WebSocket implementation not available in this Node runtime');
  }

  const { limit = DEFAULT_BATCH_SIZE, since = null, until = null } = options;

  return new Promise((resolve, reject) => {
    const events = [];
    let ws;
    const timeout = setTimeout(() => {
      try {
        if (ws) ws.close();
      } catch {}
      reject(new Error('WebSocket timeout'));
    }, 30000);

    try {
      ws = new WebSocketImpl(relayUrl);

      const addHandler = ws.addEventListener
        ? (type, handler) => ws.addEventListener(type, handler)
        : (type, handler) => ws.on(type, handler);

      addHandler('open', () => {
        const subscriptionId = Math.random().toString(36).slice(2);
        const filter = { kinds: [34236], limit };
        if (since != null) filter.since = since;
        if (until != null) filter.until = until;
        ws.send(JSON.stringify(['REQ', subscriptionId, filter]));

        addHandler('message', (message) => {
          const raw = typeof message?.data === 'string' ? message.data : message?.toString?.() || '';
          try {
            const payload = JSON.parse(raw);
            if (payload[0] === 'EVENT' && payload[1] === subscriptionId) {
              events.push(payload[2]);
            }
            if (payload[0] === 'EOSE' && payload[1] === subscriptionId) {
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              resolve(events);
            }
          } catch (error) {
            console.error('[DOWNGRADE] Failed to parse relay message:', error.message);
          }
        });
      });

      addHandler('error', (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('WebSocket error'));
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function dedupeCandidates(candidates) {
  const bySha = new Map();
  for (const candidate of candidates) {
    if (!candidate?.sha256) continue;
    if (!bySha.has(candidate.sha256)) {
      bySha.set(candidate.sha256, candidate);
    }
  }
  return [...bySha.values()];
}

function loadCandidatesFromInput(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const parsed = readJsonFile(resolvedPath);
  const rawItems = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.videos)
      ? parsed.videos
      : Array.isArray(parsed?.sha256s)
        ? parsed.sha256s.map((sha256) => ({ sha256 }))
        : [];

  return rawItems.map((item) => {
    if (typeof item === 'string') {
      return { sha256: item.toLowerCase(), eventId: null, nostrContext: null };
    }
    return {
      sha256: typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : null,
      eventId: item.eventId || null,
      nostrContext: item.nostrContext || null
    };
  }).filter((item) => item.sha256);
}

async function fetchDecision(sha256, options = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const response = await fetchImpl(buildDecisionLookupUrl(sha256, options), {
    headers: buildRequestHeaders(options)
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Decision lookup failed for ${sha256}: HTTP ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  return hasAdminSessionAuth(options) ? payload?.video || null : payload;
}

async function updateDecisionToAgeRestricted(sha256, options = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const updateUrl = hasAdminSessionAuth(options)
    ? `${options.adminOrigin || DEFAULT_ADMIN_ORIGIN}/admin/api/moderate/${sha256}`
    : `${options.workerUrl}/api/v1/moderate`;
  const response = await fetchImpl(updateUrl, buildAgeRestrictedUpdateRequest(sha256, options));

  if (!response.ok) {
    throw new Error(`Moderation update failed for ${sha256}: HTTP ${response.status} ${await response.text()}`);
  }

  return response.json();
}

function buildInitialStats() {
  return {
    discovered: 0,
    eligible: 0,
    updated: 0,
    skippedHumanReviewed: 0,
    skippedReviewNotes: 0,
    skippedSafe: 0,
    skippedAlreadyAgeRestricted: 0,
    skippedNoDecision: 0,
    skippedNotVine: 0,
    failed: 0
  };
}

function recordSkip(stats, reason) {
  switch (reason) {
    case 'human-reviewed':
      stats.skippedHumanReviewed++;
      break;
    case 'review-notes-present':
      stats.skippedReviewNotes++;
      break;
    case 'already-safe':
      stats.skippedSafe++;
      break;
    case 'already-age-restricted':
      stats.skippedAlreadyAgeRestricted++;
      break;
    case 'no-decision':
      stats.skippedNoDecision++;
      break;
    case 'not-vine':
      stats.skippedNotVine++;
      break;
    default:
      break;
  }
}

async function discoverCandidates(options, deps = {}) {
  if (options.inputPath) {
    return dedupeCandidates(loadCandidatesFromInput(options.inputPath));
  }

  const allCandidates = [];
  let currentUntil = options.until;

  while (true) {
    const events = await fetchRelayEvents(options.relayUrl, {
      limit: options.batchSize,
      since: options.since,
      until: currentUntil
    }, deps);

    if (events.length === 0) {
      break;
    }

    for (const event of events) {
      const candidate = extractClassicVineCandidateFromEvent(event);
      if (candidate) {
        allCandidates.push(candidate);
      }
    }

    const oldestCreatedAt = events.reduce((oldest, event) => {
      if (!Number.isFinite(event?.created_at)) return oldest;
      return oldest == null ? event.created_at : Math.min(oldest, event.created_at);
    }, null);

    if (oldestCreatedAt == null) {
      break;
    }

    currentUntil = oldestCreatedAt - 1;
    if (options.since != null && currentUntil < options.since) {
      break;
    }
    if (events.length < options.batchSize) {
      break;
    }
    if (options.maxTotal && allCandidates.length >= options.maxTotal) {
      break;
    }
  }

  const candidates = dedupeCandidates(allCandidates);
  return options.maxTotal ? candidates.slice(0, options.maxTotal) : candidates;
}

export async function runClassicVineAgeRestrictionDowngrade(options = {}, deps = {}) {
  if (Boolean(options.adminOrigin) !== Boolean(options.cfAccessCookie)) {
    throw new Error('Admin session mode requires both adminOrigin and cfAccessCookie.');
  }

  if (!options.apiToken && !hasAdminSessionAuth(options)) {
    throw new Error('Missing auth. Set SERVICE_API_TOKEN or MODERATION_API_TOKEN, or pass --token. For admin-session mode, pass --admin-origin and --cf-access-cookie.');
  }

  const stats = buildInitialStats();
  const report = {
    mode: options.mode,
    relay: options.relayUrl,
    worker: options.workerUrl,
    startedAt: new Date().toISOString(),
    results: []
  };

  const discoverCandidatesImpl = deps.discoverCandidates || discoverCandidates;
  const candidates = await discoverCandidatesImpl(options, deps);
  stats.discovered = candidates.length;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const decision = await fetchDecision(candidate.sha256, options, deps);
    const classification = classifyDecisionForDowngrade(decision);

    if (!classification.eligible) {
      recordSkip(stats, classification.reason);
      report.results.push({
        sha256: candidate.sha256,
        eventId: candidate.eventId,
        result: classification.reason
      });
      continue;
    }

    stats.eligible++;

    if (options.mode === 'preview') {
      report.results.push({
        sha256: candidate.sha256,
        eventId: candidate.eventId,
        result: 'eligible'
      });
      continue;
    }

    try {
      const response = await updateDecisionToAgeRestricted(candidate.sha256, options, deps);
      stats.updated++;
      report.results.push({
        sha256: candidate.sha256,
        eventId: candidate.eventId,
        result: 'updated',
        response
      });
    } catch (error) {
      stats.failed++;
      report.results.push({
        sha256: candidate.sha256,
        eventId: candidate.eventId,
        result: 'failed',
        error: error.message
      });
    }

    if (options.concurrency > 0 && index + 1 < candidates.length) {
      await sleep(100);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.stats = stats;
  return report;
}

async function main() {
  const options = parseArgs();
  const report = await runClassicVineAgeRestrictionDowngrade(options);
  writeJsonFile(options.reportPath, report);
  console.log(JSON.stringify({
    mode: options.mode,
    stats: report.stats,
    reportPath: options.reportPath
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[DOWNGRADE] Fatal error:', error);
    process.exit(1);
  });
}
