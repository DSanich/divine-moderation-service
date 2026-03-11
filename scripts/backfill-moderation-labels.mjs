#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Backfill script to populate ClickHouse moderation_labels from existing D1 moderation_results
// ABOUTME: Reads decisions via the moderation service API, normalizes labels, and batch inserts

import { normalizeLabel, classifierCategoryToLabels } from '../src/moderation/vocabulary.mjs';

const BATCH_SIZE = 100;
const THRESHOLD = 0.5;

const SOURCE_METADATA = {
  source_id: 'divine-hive',
  source_owner: 'divine',
  source_type: 'machine-labeler',
  transport: 'moderation-api',
};

function getConfig() {
  const apiUrl = process.env.MODERATION_API_URL || 'https://moderation.api.divine.video';
  const apiToken = process.env.MODERATION_API_TOKEN || process.env.SERVICE_API_TOKEN;
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  const clickhouseUser = process.env.CLICKHOUSE_USER || 'default';
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD;

  if (!apiToken) {
    console.error('[BACKFILL] MODERATION_API_TOKEN or SERVICE_API_TOKEN is required');
    process.exit(1);
  }
  if (!clickhouseUrl || !clickhousePassword) {
    console.error('[BACKFILL] CLICKHOUSE_URL and CLICKHOUSE_PASSWORD are required');
    process.exit(1);
  }

  return { apiUrl, apiToken, clickhouseUrl, clickhouseUser, clickhousePassword };
}

/**
 * Fetch decisions from the moderation service API with pagination
 */
async function fetchDecisions(apiUrl, apiToken, cursor = null, limit = BATCH_SIZE) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);

  const url = `${apiUrl}/api/v1/decisions?${params}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch decisions: ${resp.status} ${await resp.text()}`);
  }

  return resp.json();
}

/**
 * Convert a moderation decision row into ClickHouse label rows
 */
function decisionToLabelRows(decision) {
  const rows = [];
  const scores = typeof decision.scores === 'string'
    ? JSON.parse(decision.scores)
    : decision.scores || {};

  const reviewState = decision.reviewed_by ? 'human-confirmed' : 'automated';

  for (const [cat, score] of Object.entries(scores)) {
    if (typeof score !== 'number' || score < THRESHOLD) continue;
    const labels = classifierCategoryToLabels(cat, score);
    for (const label of labels) {
      rows.push({
        sha256: decision.sha256,
        label: normalizeLabel(label),
        ...SOURCE_METADATA,
        confidence: score,
        operation: 'apply',
        review_state: reviewState,
        action: decision.action || '',
        updated_at: decision.moderated_at || new Date().toISOString(),
      });
    }
  }

  return rows;
}

/**
 * Write a batch of label rows to ClickHouse
 */
async function writeToClickHouse(rows, config) {
  if (rows.length === 0) return;

  const query = 'INSERT INTO moderation_labels FORMAT JSONEachRow';
  const body = rows.map(r => JSON.stringify(r)).join('\n');

  const resp = await fetch(`${config.clickhouseUrl}/?database=default&query=${encodeURIComponent(query)}`, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': config.clickhouseUser,
      'X-ClickHouse-Key': config.clickhousePassword,
      'Content-Type': 'application/x-ndjson',
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ClickHouse write failed: ${resp.status} ${text}`);
  }
}

async function main() {
  const config = getConfig();
  console.log('[BACKFILL] Starting moderation labels backfill');
  console.log(`[BACKFILL] API: ${config.apiUrl}`);
  console.log(`[BACKFILL] ClickHouse: ${config.clickhouseUrl}`);

  let cursor = null;
  let totalDecisions = 0;
  let totalLabelsWritten = 0;
  let batchNumber = 0;

  while (true) {
    batchNumber++;
    const data = await fetchDecisions(config.apiUrl, config.apiToken, cursor);
    const decisions = data.decisions || data.results || [];

    if (decisions.length === 0) {
      console.log('[BACKFILL] No more decisions to process');
      break;
    }

    // Convert all decisions in this batch to label rows
    const allRows = [];
    for (const decision of decisions) {
      const rows = decisionToLabelRows(decision);
      allRows.push(...rows);
    }

    // Write batch to ClickHouse
    if (allRows.length > 0) {
      await writeToClickHouse(allRows, config);
    }

    totalDecisions += decisions.length;
    totalLabelsWritten += allRows.length;

    console.log(
      `[BACKFILL] Batch ${batchNumber}: processed ${decisions.length} decisions, ` +
      `wrote ${allRows.length} labels (total: ${totalDecisions} decisions, ${totalLabelsWritten} labels)`
    );

    // Check for next page
    cursor = data.cursor || data.next_cursor;
    if (!cursor || decisions.length < BATCH_SIZE) {
      break;
    }
  }

  console.log(`[BACKFILL] Complete! Processed ${totalDecisions} decisions, wrote ${totalLabelsWritten} labels`);
}

main().catch(err => {
  console.error('[BACKFILL] Fatal error:', err);
  process.exit(1);
});
