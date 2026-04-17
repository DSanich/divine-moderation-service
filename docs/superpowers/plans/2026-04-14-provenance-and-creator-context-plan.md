# Provenance And Creator Context Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add normalized provenance and creator-context data to admin moderation surfaces so moderators can identify likely original Vine, pre-2022 legacy, and C2PA/ProofMode-attested content, plus inspect creator history. Provenance is guidance-only EXCEPT two targeted enforcement rules: (1) valid ProofMode capture-authentication downgrades Hive/RD AI-driven QUARANTINE to REVIEW so humans decide, and (2) valid C2PA signed by a known AI-generation tool is an independent trigger for QUARANTINE — the tool's own cryptographic declaration is authoritative AI evidence, so we don't serve the content until a human makes a labeling/approval call.

**Architecture:** Compute provenance once on the backend. Age/origin signals come from Nostr/import/ingest evidence; C2PA/ProofMode signals come from the `divine-inquisitor` microservice (`github.com/divinevideo/divine-inquisitor`), called from the moderation pipeline **before Hive** so that signed-AI content short-circuits the Hive call entirely. Results are persisted on the moderation record and KV-cached. Return a normalized `provenance` object in every admin video payload. Enrich creator data with local moderation stats plus public `api.divine.video` profile/social endpoints. Render compact provenance badges (age-origin + proofmode, independent) and an on-demand `Creator Info` panel in dashboard and swipe review.

**Tech Stack:** Cloudflare Workers, Vitest, D1, KV, static admin HTML/JS, public Funnelcake REST API (`api.divine.video`), divine-inquisitor (HTTP `POST /verify`)

**External service:** Divine-inquisitor is live at `https://inquisitor.divine.video` (confirmed 2026-04-17: `/health` returns `{"status":"ok","service":"divine-inquisitor","version":"0.1.0"}`). No auth required per current k8s config. Configure the worker with `INQUISITOR_BASE_URL=https://inquisitor.divine.video`.

---

## File Structure

- Create: `src/admin/provenance.mjs`
  Backend-only helper for provenance normalization, date-source ranking, and C2PA state normalization.
- Create: `src/admin/provenance.test.mjs`
  Unit tests for provenance classification, guardrails, and C2PA state derivation.
- Create: `src/admin/creator-context.mjs`
  Backend helper for local + Funnelcake creator enrichment.
- Create: `src/admin/creator-context.test.mjs`
  Unit tests for Funnelcake enrichment and fallback behavior.
- Create: `src/moderation/inquisitor-client.mjs`
  HTTP client for `divine-inquisitor` C2PA verification — URL mode, timeout, graceful degradation.
- Create: `src/moderation/inquisitor-client.test.mjs`
  Unit tests for inquisitor client with mocked fetch.
- Modify: `src/moderation/pipeline.mjs`
  Call inquisitor in parallel with existing providers; persist C2PA result; apply ProofMode enforcement rule (valid_proofmode + AI flag → REVIEW instead of QUARANTINE).
- Modify: `src/moderation/pipeline.test.mjs`
  Cover the ProofMode enforcement rule and fall-through behavior for every other state.
- Modify: `src/nostr/relay-client.mjs`
  Preserve `publishedAt`, `createdAt`, platform, sourceUrl, and Vine IDs for age/origin provenance.
- Modify: `src/nostr/relay-client.test.mjs`
  Extend parsing coverage for preserved metadata fields.
- Modify: `src/index.mjs`
  Thread provenance (age/origin + proofmode) and creator context through admin lookup/list/review payloads.
- Modify: `src/index.test.mjs`
  Add end-to-end admin payload coverage.
- Modify: `src/admin/dashboard.html`
  Render independent age-origin and ProofMode badges, support line, and add `Creator Info` modal/popover behavior.
- Modify: `src/admin/swipe-review.html`
  Render the same provenance summary and creator-info affordance.
- Modify: `wrangler.toml`
  Add `INQUISITOR_BASE_URL` var, `C2PA_CACHE` KV namespace binding (or reuse existing KV with a `c2pa:` prefix — decide in Chunk 6).

## Chunk 1: Backend Provenance Normalization

### Task 1: Add provenance helper with failing tests first

**Files:**
- Create: `src/admin/provenance.test.mjs`
- Create: `src/admin/provenance.mjs`
- Modify: `src/nostr/relay-client.mjs`
- Modify: `src/nostr/relay-client.test.mjs`

- [ ] **Step 1: Write the failing provenance unit tests**

```js
import { describe, expect, it } from 'vitest';
import { buildProvenance } from './provenance.mjs';

describe('buildProvenance', () => {
  it('classifies strong Vine evidence as original_vine', () => {
    const result = buildProvenance({
      nostrContext: {
        platform: 'vine',
        sourceUrl: 'https://vine.co/v/abc',
        publishedAt: 1408579200
      },
      receivedAt: '2026-04-14T00:00:00.000Z'
    });

    expect(result.status).toBe('original_vine');
    expect(result.isOriginalVine).toBe(true);
    expect(result.dateSource).toBe('published_at');
  });

  it('classifies published_at before 2022 as pre_2022_legacy', () => {
    const result = buildProvenance({
      nostrContext: { publishedAt: 1637193600 },
      receivedAt: '2026-04-14T00:00:00.000Z'
    });

    expect(result.status).toBe('pre_2022_legacy');
    expect(result.isPre2022).toBe(true);
  });

  it('does not treat receivedAt alone as legacy', () => {
    const result = buildProvenance({
      nostrContext: null,
      receivedAt: '2020-01-01T00:00:00.000Z'
    });

    expect(result.status).toBe('unknown_or_modern');
    expect(result.dateSource).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/admin/provenance.test.mjs src/nostr/relay-client.test.mjs`

Expected: FAIL because `src/admin/provenance.mjs` does not exist and preserved-field expectations are not implemented.

- [ ] **Step 3: Write the minimal provenance implementation**

```js
import { hasStrongOriginalVineEvidence } from '../nostr/relay-client.mjs';

const PRE_2022_CUTOFF = Date.UTC(2022, 0, 1) / 1000;

export function buildProvenance({ nostrContext, receivedAt }) {
  const reasons = [];
  const publishedAt = nostrContext?.publishedAt ?? null;
  const nostrCreatedAt = nostrContext?.createdAt ?? null;

  if (hasStrongOriginalVineEvidence(nostrContext || {})) {
    reasons.push('vine-signal');
  }

  // Pick the best trusted age signal without letting receivedAt imply legacy.
  // Return a normalized object for all admin payloads.
}
```

- [ ] **Step 4: Preserve needed metadata in relay parsing**

Add/retain these fields in `parseVideoEventMetadata` output:
- `publishedAt`
- `createdAt`
- `platform`
- `sourceUrl`
- Vine-specific IDs

Note: Do NOT try to parse a "proofmode" tag from the Nostr event. C2PA/ProofMode data lives inside the media file itself and is read by `divine-inquisitor` from the media bytes. Chunk 6 handles this end-to-end.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/admin/provenance.test.mjs src/nostr/relay-client.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/admin/provenance.mjs src/admin/provenance.test.mjs src/nostr/relay-client.mjs src/nostr/relay-client.test.mjs
git commit -m "feat: normalize admin provenance signals"
```

## Chunk 2: Backend Creator Context Enrichment

### Task 2: Add creator-context helper with local + Funnelcake fallback

**Files:**
- Create: `src/admin/creator-context.test.mjs`
- Create: `src/admin/creator-context.mjs`
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write the failing creator-context unit tests**

```js
import { describe, expect, it, vi } from 'vitest';
import { buildCreatorContext } from './creator-context.mjs';

describe('buildCreatorContext', () => {
  it('merges local moderation stats with Funnelcake profile/social data', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pubkey: 'f'.repeat(64),
        profile: { display_name: 'Alice', name: 'alice', picture: 'https://cdn/p.png' },
        stats: { video_count: 12, total_events: 88, first_activity: '2019-01-01T00:00:00Z', last_activity: '2026-04-14T00:00:00Z' }
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        follower_count: 100,
        following_count: 20
      })));

    const result = await buildCreatorContext({
      pubkey: 'f'.repeat(64),
      uploaderStats: { total_scanned: 5, flagged_count: 2, risk_level: 'elevated' },
      uploaderEnforcement: { approval_required: false, relay_banned: true }
    }, { fetchFn });

    expect(result.name).toBe('Alice');
    expect(result.stats.totalScanned).toBe(5);
    expect(result.social.followerCount).toBe(100);
    expect(result.enforcement.relayBanned).toBe(true);
  });

  it('returns local-only context when api.divine.video fails', async () => {
    const result = await buildCreatorContext({
      pubkey: 'f'.repeat(64),
      uploaderStats: { total_scanned: 2, flagged_count: 0, risk_level: 'normal' },
      uploaderEnforcement: { approval_required: false, relay_banned: false }
    }, {
      fetchFn: vi.fn().mockRejectedValue(new Error('boom'))
    });

    expect(result.stats.totalScanned).toBe(2);
    expect(result.social).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/admin/creator-context.test.mjs src/index.test.mjs`

Expected: FAIL because `buildCreatorContext` is missing and admin payloads do not expose `creatorContext`.

- [ ] **Step 3: Implement creator-context helper**

```js
const FUNNEL_BASE_URL = 'https://api.divine.video';

export async function buildCreatorContext(input, { fetchFn = fetch } = {}) {
  const { pubkey, uploaderStats, uploaderEnforcement } = input;
  if (!pubkey) return null;

  // Fetch /api/users/{pubkey} and /api/users/{pubkey}/social in parallel.
  // Merge public profile/social data with local moderation stats.
  // Never throw on remote failures; return local-only context instead.
}
```

- [ ] **Step 4: Thread creator context through admin payload builders**

Update `src/index.mjs` to:
- call `buildCreatorContext` in focused lookup enrichment
- include `creatorContext` in dashboard list items when a pubkey is present
- preserve full pubkey for profile links instead of relying only on truncated display values

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/admin/creator-context.test.mjs src/index.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/admin/creator-context.mjs src/admin/creator-context.test.mjs src/index.mjs src/index.test.mjs
git commit -m "feat: enrich admin videos with creator context"
```

## Chunk 3: Propagate Provenance Through Admin APIs

### Task 3: Return normalized provenance in all admin video shapes

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/index.test.mjs`

- [ ] **Step 1: Write/extend failing admin API tests**

Add assertions to existing admin lookup/list tests:

```js
expect(body.video.provenance).toMatchObject({
  status: 'original_vine',
  isPre2022: true,
  isOriginalVine: true
});

expect(body.video.provenance.reasons).toContain('platform:vine');
expect(body.video.creatorContext.stats.totalScanned).toBe(3);
```

Also add a list-route test that verifies `publishedAt` survives into the returned payload and is not replaced by `receivedAt`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/index.test.mjs`

Expected: FAIL because `/admin/api/video/:id`, `/admin/api/videos`, and swipe-review data do not include the normalized objects.

- [ ] **Step 3: Implement payload normalization**

For each backend path that returns admin videos:
- build `provenance` from preserved Nostr/import metadata
- attach `creatorContext`
- keep raw timestamps available for operational use
- ensure provenance is computed once per item, not re-derived in frontend code

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/index.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: expose provenance on admin video payloads"
```

## Chunk 4: Render Provenance And Creator Info In Admin UI

### Task 4: Add provenance badges and Creator Info affordance to dashboard

**Files:**
- Modify: `src/admin/dashboard.html`

- [ ] **Step 1: Write a failing regression test for dashboard UI hooks**

Create a lightweight test that reads the dashboard HTML and asserts the expected hooks exist:

```js
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dashboard provenance UI', () => {
  it('contains creator info modal hooks', () => {
    const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
    expect(html).toContain('Creator Info');
    expect(html).toContain('openCreatorInfo');
    expect(html).toContain('provenance');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/admin/dashboard-ui.test.mjs`

Expected: FAIL because the new hooks/labels do not exist yet.

- [ ] **Step 3: Implement dashboard rendering**

Add to each card:
- provenance badge
- provenance support line with date source
- `Creator Info` button

Add a shared modal/popover renderer that shows:
- creator name/avatar/pubkey
- Divine profile link
- local moderation counters/risk/enforcement badges
- Funnelcake social stats when available
- provenance evidence details and reasons

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/admin/dashboard-ui.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/dashboard.html src/admin/dashboard-ui.test.mjs
git commit -m "feat: show provenance and creator info in dashboard"
```

### Task 5: Add the same provenance and Creator Info affordance to swipe review

**Files:**
- Modify: `src/admin/swipe-review.html`

- [ ] **Step 1: Write a failing regression test for swipe-review UI hooks**

Use the same HTML-file assertion pattern for:
- `Creator Info`
- provenance badge/support text
- modal/popover open function

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/admin/swipe-review-ui.test.mjs`

Expected: FAIL because swipe review does not include the new hooks.

- [ ] **Step 3: Implement swipe-review rendering**

Render the normalized provenance summary from backend payloads and reuse the creator-info UI pattern from dashboard, keeping card density intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/admin/swipe-review-ui.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/swipe-review.html src/admin/swipe-review-ui.test.mjs
git commit -m "feat: show provenance and creator info in swipe review"
```

## Chunk 5a: Divine-Inquisitor Client

### Task 6a: Build the inquisitor HTTP client with failing tests first

**Files:**
- Create: `src/moderation/inquisitor-client.test.mjs`
- Create: `src/moderation/inquisitor-client.mjs`
- Modify: `wrangler.toml`

- [ ] **Step 1: Write the failing inquisitor-client unit tests**

Tests should cover:
- URL-mode request shape (`POST`, `Content-Type: application/json`, body `{url, mime_type}`)
- Successful response parsing into normalized state: `valid_proofmode`, `valid_c2pa`, `valid_ai_signed`, `invalid`, `absent`
- `is_proofmode=true && valid=true` → state `valid_proofmode`
- `valid=true && !is_proofmode && claim_generator` matches AI-tool pattern → state `valid_ai_signed`
- `valid=true && !is_proofmode` with neutral claim_generator → state `valid_c2pa`
- `has_c2pa=true && valid=false` → state `invalid`
- `has_c2pa=false` → state `absent`
- Timeout/network error → state `unchecked` with error captured, never throws
- Honors configured base URL and request timeout

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/moderation/inquisitor-client.test.mjs`

Expected: FAIL because `inquisitor-client.mjs` does not exist.

- [ ] **Step 3: Implement the client**

Keep it thin — mirror the shape of `src/moderation/realness-client.mjs` (separate concerns: network call, response normalization, error-to-state mapping). Normalize into:

```js
{
  state: 'valid_proofmode' | 'valid_c2pa' | 'valid_ai_signed' | 'invalid' | 'absent' | 'unchecked',
  hasC2pa: boolean,
  valid: boolean,
  isProofmode: boolean,
  validationState: string,
  claimGenerator: string | null,
  captureDevice: string | null,
  captureTime: string | null,
  signer: string | null,
  assertions: string[],
  verifiedAt: string,
  checkedAt: string,
  error: string | null
}
```

Known AI claim-generator substrings to watch for (case-insensitive): `adobe firefly`, `dall·e`, `dall-e`, `midjourney`, `stable diffusion`, `sora`, `runway`, `ideogram`. Keep the list in one place for easy edits.

- [ ] **Step 4: Add wrangler binding**

Add `INQUISITOR_BASE_URL` to `wrangler.toml` vars. Document the expected value format in a comment.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/moderation/inquisitor-client.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/moderation/inquisitor-client.mjs src/moderation/inquisitor-client.test.mjs wrangler.toml
git commit -m "feat: add divine-inquisitor C2PA verification client"
```

## Chunk 5b: Pipeline Integration + ProofMode + Signed-AI Enforcement Rules

### Task 6b: Wire inquisitor into the pipeline and implement the two enforcement rules

**Files:**
- Modify: `src/moderation/pipeline.mjs`
- Modify: `src/moderation/pipeline.test.mjs`
- Modify: `src/admin/provenance.mjs` (attach proofmode result into the provenance object)
- Modify: `src/admin/provenance.test.mjs`

- [ ] **Step 1: Write failing pipeline tests for both enforcement rules**

Cover every row of the policy table in `policy_proofmode_ai.md`. The pipeline's call order is inquisitor → then Hive only if not short-circuited.

Signed-AI short-circuit (inquisitor-first):
- `valid_ai_signed` returned by inquisitor → action = QUARANTINE, **Hive is never called**, Reality Defender is not scheduled. Assert the Hive mock receives zero calls. The reason string includes the claim_generator.
- `valid_ai_signed` also works when Hive would have flagged (assert short-circuit still skips Hive — the order matters).

ProofMode downgrade (post-Hive):
- `valid_proofmode` + Hive flags AI → Hive IS called, then action downgrades from QUARANTINE to REVIEW.
- `valid_proofmode` + Hive does NOT flag AI → action stays SAFE.

Fall-through (Hive runs as today):
- `valid_c2pa` + Hive flags AI → action stays QUARANTINE.
- `valid_c2pa` + Hive does NOT flag AI → action stays SAFE.
- `invalid` + Hive flags AI → action stays QUARANTINE.
- `invalid` + Hive does NOT flag AI → action stays SAFE (invalid alone does not escalate).
- `absent` + Hive flags AI → action stays QUARANTINE.
- `unchecked` (inquisitor timeout/error) → Hive IS called, action determined by Hive as today. `unchecked` is treated as absent — never block moderation on verification latency, and never short-circuit Hive.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/moderation/pipeline.test.mjs`

Expected: FAIL — pipeline does not call inquisitor or apply either rule yet.

- [ ] **Step 3: Implement pipeline integration**

Changes in `src/moderation/pipeline.mjs` — the new call order is inquisitor-first with a short-circuit:

1. **Call inquisitor first** (`POST /verify`, URL mode, against the media.divine.video URL). Apply the realness-client timeout discipline — never block moderation on verification failure; on timeout/error, record state `unchecked` and continue.
2. Cache the inquisitor result in KV under `c2pa:{sha256}` with a 30-day TTL.
3. **Signed-AI short-circuit:** if C2PA state is `valid_ai_signed`, set action = QUARANTINE, reason = `c2pa-ai-signed:{claimGenerator}`, **return early — do not call Hive, do not schedule Reality Defender polling**. Persist the moderation record with a marker that this path was taken so the admin payload can show which rule fired.
4. **Otherwise, call Hive** as today and run classify() to produce the proposed action.
5. **ProofMode downgrade:** if the proposed action is QUARANTINE and the AI-driven reason triggered it (Hive `ai_generated`/`deepfake`, or RD confirming AI), AND C2PA state is `valid_proofmode`, downgrade action to REVIEW and append reason like `proofmode-capture-authenticated`.
6. Persist the normalized C2PA object on the moderation record so the admin payload can return it without re-verifying.

The two rules are mutually exclusive by construction: `valid_proofmode` requires `is_proofmode=true`, and `valid_ai_signed` requires the claim_generator to be an AI tool (capture tools and AI tools do not overlap). Add a test to prove both cannot fire on the same record, and a test asserting the Hive mock receives zero calls on the `valid_ai_signed` path.

- [ ] **Step 4: Attach proofmode into the provenance object**

In `src/admin/provenance.mjs`, accept an optional `proofmode` input and emit it on the returned object as `provenance.proofmode`. Add tests for the three representative states (valid_proofmode, invalid, absent).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/moderation/pipeline.test.mjs src/admin/provenance.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/moderation/pipeline.mjs src/moderation/pipeline.test.mjs src/admin/provenance.mjs src/admin/provenance.test.mjs
git commit -m "feat: C2PA pipeline integration with ProofMode downgrade and signed-AI upgrade rules"
```

## Chunk 5c: Dashboard ProofMode Badge

### Task 6c: Render ProofMode state as a distinct badge alongside the age-origin badge

**Files:**
- Modify: `src/admin/dashboard.html`
- Modify: `src/admin/swipe-review.html`
- Modify: `src/admin/dashboard-ui.test.mjs` (from earlier Task 4)
- Modify: `src/admin/swipe-review-ui.test.mjs` (from earlier Task 5)

- [ ] **Step 1: Extend UI-hook tests**

Assert the HTML contains:
- a proofmode-badge hook (id/class)
- label text for each state: `Valid ProofMode`, `Valid C2PA`, `Valid but AI-signed`, `Invalid Proof`
- a supporting-line pattern like `ProofMode captured` when capture_time and capture_device are present

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/admin/dashboard-ui.test.mjs src/admin/swipe-review-ui.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement UI rendering**

- Render the ProofMode badge independently from the age-origin badge — they measure different things and should both be visible when both are informative.
- Hide the ProofMode badge entirely when `state === "absent"` (most content).
- Use distinct visual weight: `valid_proofmode` green, `valid_c2pa` blue, `valid_ai_signed` orange, `invalid` gray.
- Expose full C2PA detail (signer, assertions, validation results) inside the existing `Creator Info` modal, not on the card.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/admin/dashboard-ui.test.mjs src/admin/swipe-review-ui.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/dashboard.html src/admin/swipe-review.html src/admin/dashboard-ui.test.mjs src/admin/swipe-review-ui.test.mjs
git commit -m "feat: show ProofMode and C2PA state on moderation cards"
```

## Chunk 5: Full Verification

### Task 6: Run focused verification and capture manual checks

**Files:**
- Modify: `docs/superpowers/specs/2026-04-14-provenance-and-creator-context-design.md` (only if implementation changed the design)

- [ ] **Step 1: Run the focused automated suite**

Run:

```bash
npm test -- src/admin/provenance.test.mjs src/admin/creator-context.test.mjs src/nostr/relay-client.test.mjs src/index.test.mjs src/admin/dashboard-ui.test.mjs src/admin/swipe-review-ui.test.mjs
```

Expected: PASS

- [ ] **Step 2: Run the broader suite before handoff**

Run: `npm test`

Expected: PASS

- [ ] **Step 3: Manually verify in the admin UI**

Check:
- a known original Vine shows `Original Vine`
- a known pre-2022 non-Vine import shows `Pre-2022 Legacy`
- a modern or unknown sample shows `Unknown Provenance`
- `Creator Info` opens in both dashboard and swipe review
- external `api.divine.video` failure still leaves local moderation stats visible

- [ ] **Step 4: Commit any final polish**

```bash
git add src/admin src/index.mjs src/index.test.mjs src/nostr/relay-client.mjs src/nostr/relay-client.test.mjs
git commit -m "test: verify provenance and creator context rollout"
```
