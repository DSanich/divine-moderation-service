// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Export recent moderation decisions + VLM classifier data as JSONL
// ABOUTME: for offline evaluation against a gpt-oss-safeguard policy prompt.
//
// Read-only. Hits the admin API endpoints (/api/v1/decisions + /api/v1/classifier/:sha256)
// and writes one JSON object per line to stdout or --out. Feed the output to a local
// Ollama/vLLM/Colab safeguard run, then diff the model's action vs. the `action` field.
//
// Usage:
//   node scripts/export-for-safeguard-eval.mjs \
//     --worker https://moderation.admin.divine.video \
//     --token $MODERATION_API_TOKEN \
//     --limit 200 \
//     --out tmp/safeguard-eval-set.jsonl
//
// Optional filters:
//   --action QUARANTINE       only include rows with this action (repeatable)
//   --since 2026-03-01        ISO date; skip rows moderated earlier
//   --require-vlm             drop rows with no VLM classifier data in KV

import fs from 'fs';
import process from 'process';

function parseArgs(argv) {
  const args = { actions: [], limit: 200, requireVlm: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--worker': args.worker = next; i++; break;
      case '--token': args.token = next; i++; break;
      case '--limit': args.limit = Number(next); i++; break;
      case '--action': args.actions.push(next); i++; break;
      case '--since': args.since = next; i++; break;
      case '--out': args.out = next; i++; break;
      case '--require-vlm': args.requireVlm = true; break;
      case '--help':
      case '-h':
        console.log(`See header comment in ${import.meta.url} for usage.`);
        process.exit(0);
    }
  }
  args.worker = args.worker || process.env.MODERATION_WORKER_URL;
  args.token = args.token || process.env.MODERATION_API_TOKEN || process.env.SERVICE_API_TOKEN;
  if (!args.worker) throw new Error('Missing --worker or MODERATION_WORKER_URL');
  if (!args.token) throw new Error('Missing --token or MODERATION_API_TOKEN');
  return args;
}

async function apiGet(path, { worker, token }) {
  const res = await fetch(`${worker}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function fetchDecisions({ worker, token, limit, actions, since }) {
  const pageSize = 100;
  const all = [];
  let cursor = null;
  while (all.length < limit) {
    const qs = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) qs.set('cursor', cursor);
    const page = await apiGet(`/api/v1/decisions?${qs}`, { worker, token });
    const rows = page.decisions || page.results || page.items || page;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (actions.length && !actions.includes(row.action)) continue;
      if (since && row.moderated_at && row.moderated_at < since) continue;
      all.push(row);
      if (all.length >= limit) break;
    }
    cursor = page.next_cursor || page.nextCursor || null;
    if (!cursor) break;
  }
  return all.slice(0, limit);
}

async function fetchClassifier(sha256, ctx) {
  try {
    const payload = await apiGet(`/api/v1/classifier/${sha256}`, ctx);
    return payload?.classifier_data || null;
  } catch {
    return null;
  }
}

function toEvalRecord(decision, classifier) {
  const scores = safeParse(decision.scores);
  const categories = safeParse(decision.categories);
  const vlm = classifier || {};
  return {
    sha256: decision.sha256,
    ground_truth: {
      action: decision.action,
      reviewed_by: decision.reviewed_by || null,
      reviewed_at: decision.reviewed_at || null,
      review_notes: decision.review_notes || null
    },
    content: {
      title: decision.title || null,
      author: decision.author || null,
      uploaded_by: decision.uploaded_by || null,
      published_at: decision.published_at || null,
      event_id: decision.event_id || null,
      content_url: decision.content_url || null
    },
    signals: {
      provider: decision.provider || null,
      categories,
      scores,
      moderated_at: decision.moderated_at || null
    },
    vlm: {
      description: vlm.description || null,
      topics: vlm.topics || [],
      setting: vlm.setting || null,
      objects: vlm.objects || [],
      activities: vlm.activities || [],
      mood: vlm.mood || null,
      top_categories: vlm.topCategories || vlm.top_categories || [],
      top_settings: vlm.topSettings || vlm.top_settings || [],
      top_objects: vlm.topObjects || vlm.top_objects || []
    }
  };
}

function safeParse(val) {
  if (val == null) return null;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = { worker: args.worker, token: args.token };

  console.error(`[EXPORT] fetching up to ${args.limit} decisions from ${args.worker}`);
  const decisions = await fetchDecisions({ ...ctx, limit: args.limit, actions: args.actions, since: args.since });
  console.error(`[EXPORT] got ${decisions.length} decisions, fetching VLM data...`);

  const out = args.out ? fs.createWriteStream(args.out) : process.stdout;
  let written = 0;
  let skippedNoVlm = 0;
  for (const dec of decisions) {
    const classifier = await fetchClassifier(dec.sha256, ctx);
    if (args.requireVlm && !classifier) { skippedNoVlm++; continue; }
    const record = toEvalRecord(dec, classifier);
    out.write(JSON.stringify(record) + '\n');
    written++;
  }

  if (args.out) out.end();
  console.error(`[EXPORT] wrote ${written} records${skippedNoVlm ? ` (skipped ${skippedNoVlm} missing VLM)` : ''}`);
}

main().catch((err) => {
  console.error('[EXPORT] failed:', err.message);
  process.exit(1);
});
