// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Batch unban false positive PERMANENT_BAN decisions
// ABOUTME: Scans moderation DB for bans where no score exceeds threshold, sets them to SAFE

const THRESHOLDS = {
  nudity: 0.8,
  ai_generated: 0.8,
  deepfake: 0.8,
  offensive: 0.8,
  violence: 0.8,
  gore: 0.8,
  self_harm: 0.7,
  weapon: 0.8,
};

function getApiToken() {
  return process.env.MODERATION_API_TOKEN || process.env.SERVICE_API_TOKEN || null;
}

function isFalsePositive(scores) {
  for (const [key, threshold] of Object.entries(THRESHOLDS)) {
    if ((scores[key] || 0) >= threshold) return false;
  }
  return true;
}

async function fetchBannedDecisions(workerUrl, apiToken, offset = 0, limit = 100) {
  const response = await fetch(
    `${workerUrl}/api/v1/decisions?action=PERMANENT_BAN&limit=${limit}&offset=${offset}`,
    { headers: { 'Authorization': `Bearer ${apiToken}` } }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const data = await response.json();
  return data.decisions || [];
}

async function unbanVideo(sha256, workerUrl, apiToken) {
  const response = await fetch(`${workerUrl}/api/v1/moderate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    },
    body: JSON.stringify({
      sha256,
      action: 'SAFE',
      reason: 'false-positive-unban: no score exceeded threshold',
      source: 'batch-unban-script'
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }
  return await response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const workerUrl = args.find((_, i, a) => a[i - 1] === '--worker') || 'https://moderation-api.divine.video';
  const tokenArg = args.find((_, i, a) => a[i - 1] === '--token');
  const concurrency = parseInt(args.find((_, i, a) => a[i - 1] === '--concurrency') || '5', 10);
  const apiToken = tokenArg || getApiToken();

  if (!apiToken) {
    console.error('Missing API token. Set SERVICE_API_TOKEN or pass --token <token>');
    process.exit(1);
  }

  console.log(`[UNBAN] Starting batch unban of false positive PERMANENT_BANs`);
  console.log(`[UNBAN] Worker: ${workerUrl}`);
  console.log(`[UNBAN] Dry-run: ${dryRun}`);
  console.log(`[UNBAN] Concurrency: ${concurrency}`);
  console.log('');

  // Phase 1: Scan all PERMANENT_BAN decisions to find false positives
  console.log('[UNBAN] Phase 1: Scanning for false positives...');
  const falsePositives = [];
  let offset = 0;

  while (true) {
    const decisions = await fetchBannedDecisions(workerUrl, apiToken, offset);
    if (decisions.length === 0) break;

    for (const d of decisions) {
      if (isFalsePositive(d.scores)) {
        const top = Object.entries(d.scores)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        falsePositives.push({
          sha256: d.sha256,
          topScores: top.map(([k, v]) => `${k}=${v.toFixed(6)}`).join(', ')
        });
      }
    }

    offset += decisions.length;
    process.stdout.write(`\r[UNBAN] Scanned ${offset} decisions, found ${falsePositives.length} false positives`);

    if (decisions.length < 100) break;
  }

  console.log('');
  console.log(`[UNBAN] Found ${falsePositives.length} false positives out of ${offset} PERMANENT_BAN decisions`);
  console.log('');

  if (falsePositives.length === 0) {
    console.log('[UNBAN] No false positives found. Done!');
    return;
  }

  // Phase 2: Unban false positives
  if (dryRun) {
    console.log('[UNBAN] DRY RUN - would unban these:');
    for (const fp of falsePositives) {
      console.log(`  ${fp.sha256} (${fp.topScores})`);
    }
    console.log(`\n[UNBAN] Total: ${falsePositives.length} videos would be unbanned`);
    return;
  }

  console.log(`[UNBAN] Phase 2: Unbanning ${falsePositives.length} videos...`);
  let unbanned = 0;
  let failed = 0;

  for (let i = 0; i < falsePositives.length; i += concurrency) {
    const chunk = falsePositives.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (fp) => {
        const result = await unbanVideo(fp.sha256, workerUrl, apiToken);
        return result;
      })
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        unbanned++;
        const blossom = results[j].value.blossom_notified ? 'blossom notified' : 'blossom skipped';
        console.log(`  [OK] ${chunk[j].sha256.substring(0, 16)}... -> SAFE (${blossom})`);
      } else {
        failed++;
        console.error(`  [FAIL] ${chunk[j].sha256.substring(0, 16)}... ${results[j].reason?.message}`);
      }
    }

    // Rate limit between chunks
    if (i + concurrency < falsePositives.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`[UNBAN] Summary:`);
  console.log(`  Total false positives: ${falsePositives.length}`);
  console.log(`  Unbanned:              ${unbanned}`);
  console.log(`  Failed:                ${failed}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('[UNBAN] Fatal error:', err);
  process.exit(1);
});
