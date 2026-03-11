// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: ClickHouse label writer for moderation labels
// ABOUTME: Writes normalized, source-aware moderation rows to the shared moderation_labels table

import { normalizeLabel, classifierCategoryToLabels } from './vocabulary.mjs';

/**
 * Write normalized moderation labels to the ClickHouse moderation_labels table.
 *
 * Only writes labels with scores >= 0.5 (meaningful confidence).
 * Gracefully handles errors (logs, does not throw).
 *
 * @param {string} sha256 - Content hash
 * @param {Object} classification - Moderation classification result
 * @param {string} classification.action - Moderation action (SAFE, QUARANTINE, etc.)
 * @param {Object} classification.scores - Category scores { nudity: 0.9, violence: 0.1, ... }
 * @param {string} [classification.reviewed_by] - If set, marks as human-confirmed
 * @param {string} [classification.provider] - Provider ID
 * @param {Object} env - Worker environment bindings
 * @param {Object} [source] - Source metadata
 * @param {string} [source.sourceId] - Source identifier
 * @param {string} [source.sourceOwner] - Source owner type
 * @param {string} [source.sourceType] - Source type
 * @param {string} [source.transport] - Transport mechanism
 * @param {string} [source.operation] - Operation type (apply/clear)
 */
export async function writeModerationLabels(sha256, classification, env, source) {
  if (!env.CLICKHOUSE_URL || !env.CLICKHOUSE_PASSWORD) return;

  const { action, scores, category, severity } = classification;
  const reviewState = classification.reviewed_by ? 'human-confirmed' : 'automated';
  const sourceId = source?.sourceId || classification.provider || 'divine-hive';
  const sourceOwner = source?.sourceOwner || 'divine';
  const sourceType = source?.sourceType || 'machine-labeler';
  const transport = source?.transport || 'moderation-api';
  const operation = source?.operation || 'apply';

  // Build label rows from scores above threshold
  const rows = [];
  const thresholdForLabel = 0.5; // Only write labels with meaningful confidence

  for (const [cat, score] of Object.entries(scores || {})) {
    if (score < thresholdForLabel) continue;
    const labels = classifierCategoryToLabels(cat, score);
    for (const label of labels) {
      rows.push({
        sha256,
        label: normalizeLabel(label),
        source_id: sourceId,
        source_owner: sourceOwner,
        source_type: sourceType,
        transport,
        confidence: score,
        operation,
        review_state: reviewState,
        action: action || '',
      });
    }
  }

  if (rows.length === 0) return;

  const query = 'INSERT INTO moderation_labels FORMAT JSONEachRow';

  try {
    const resp = await fetch(`${env.CLICKHOUSE_URL}/?database=default&query=${encodeURIComponent(query)}`, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': env.CLICKHOUSE_USER || 'default',
        'X-ClickHouse-Key': env.CLICKHOUSE_PASSWORD,
        'Content-Type': 'application/x-ndjson',
      },
      body: rows.map(r => JSON.stringify({
        ...r,
        updated_at: new Date().toISOString(),
      })).join('\n'),
    });
    if (!resp.ok) {
      console.error('[LABELS] ClickHouse write failed:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('[LABELS] ClickHouse write error:', err.message);
  }
}
