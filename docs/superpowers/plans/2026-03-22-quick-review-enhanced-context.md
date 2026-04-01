# Quick Review Enhanced Context Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secondary AI verification, uploader stats/enforcement, and full lookup data to the Quick Review swipe-review page so moderators have the same rich context as the main dashboard lookup view.

**Architecture:** All changes are in a single file (`src/admin/swipe-review.html`), plus one new backend endpoint in `src/index.mjs`. The frontend gets three new features: (1) a "Verify AI" button that submits to Reality Defender and advances, (2) display of existing realness results, (3) uploader stats and enforcement badges. The backend needs a new POST endpoint to trigger Reality Defender submission from the admin UI.

**Tech Stack:** Vanilla HTML/CSS/JS (single-file SPA pattern matching existing codebase), Cloudflare Workers backend

---

## Chunk 1: Backend — Add POST endpoint for Reality Defender submission

### Task 1: Add POST /admin/api/realness/:sha256 endpoint

**Files:**
- Modify: `src/index.mjs:2518-2530` (add POST handler next to existing GET handler)

- [ ] **Step 1: Add the POST endpoint after the existing GET handler**

Insert after line 2530 (the closing `}` of the GET handler):

```javascript
    // Admin API: Submit video for Reality Defender secondary verification
    if (url.pathname.startsWith('/admin/api/realness/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const sha256 = url.pathname.split('/').pop();
      if (!isValidSha256(sha256)) {
        return new Response(JSON.stringify({ error: 'Invalid sha256' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const cdnDomain = env.CDN_DOMAIN || 'media.divine.video';
      const videoUrl = `https://${cdnDomain}/${sha256}`;

      const { submitToRealityDefender } = await import('./moderation/realness-client.mjs');
      const result = await submitToRealityDefender(sha256, videoUrl, env);

      return new Response(JSON.stringify(result), {
        status: result.submitted || result.cached ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
```

- [ ] **Step 2: Verify the endpoint works**

Deploy to staging or test locally. The endpoint should:
- Accept POST `/admin/api/realness/{sha256}` with auth
- Submit the video to Reality Defender using the CDN URL
- Return `{ submitted: true, requestId: "..." }` or `{ submitted: false, error: "...", cached: true }`

- [ ] **Step 3: Commit**

```bash
git add src/index.mjs
git commit -m "feat: add POST endpoint for Reality Defender submission from admin UI"
```

---

## Chunk 2: Frontend — Enrich fetchVideoContext and add realness functions

### Task 2: Update fetchVideoContext to pass through full lookup data

**Files:**
- Modify: `src/admin/swipe-review.html:811-826` (fetchVideoContext function)

- [ ] **Step 1: Update fetchVideoContext to return all enriched data**

Replace the current `fetchVideoContext` function (lines 811-826) with:

```javascript
    async function fetchVideoContext(sha256) {
      try {
        const resp = await fetch(`/admin/api/video/${sha256}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        const video = data.video || {};
        return {
          nostrContext: video.nostrContext || null,
          eventId: video.eventId || null,
          uploaded_by: video.uploaded_by || video.uploadedBy || null,
          divineUrl: video.divineUrl || null,
          uploaderStats: video.uploaderStats || null,
          uploaderEnforcement: video.uploaderEnforcement || null,
          detailedCategories: video.detailedCategories || null
        };
      } catch {
        return null;
      }
    }
```

- [ ] **Step 2: Update showCurrentVideo to store enriched data on the video object**

In `showCurrentVideo()`, update the `fetchVideoContext` callback (lines 741-759) to also store the new fields:

Replace:
```javascript
      if (!video.nostrContext && !video._nostrContextFetched) {
        video._nostrContextFetched = true;
        fetchVideoContext(video.sha256).then(ctx => {
          if (ctx && currentIndex < reviewQueue.length && reviewQueue[currentIndex].sha256 === video.sha256) {
            video.nostrContext = ctx.nostrContext || null;
            video.eventId = video.eventId || ctx.eventId || null;
            video.uploaded_by = video.uploaded_by || ctx.uploaded_by || null;
            // Re-render the event meta section
            const metaEl = card.querySelector('.event-meta');
            const infoEl = card.querySelector('.video-info');
            if (infoEl && !metaEl) {
              const newMetaHTML = createEventMetaHTML(video);
              if (newMetaHTML) {
                infoEl.insertAdjacentHTML('afterbegin', newMetaHTML);
              }
            }
          }
        });
      }
```

With:
```javascript
      if (!video.nostrContext && !video._nostrContextFetched) {
        video._nostrContextFetched = true;
        fetchVideoContext(video.sha256).then(ctx => {
          if (ctx && currentIndex < reviewQueue.length && reviewQueue[currentIndex].sha256 === video.sha256) {
            video.nostrContext = ctx.nostrContext || null;
            video.eventId = video.eventId || ctx.eventId || null;
            video.uploaded_by = video.uploaded_by || ctx.uploaded_by || null;
            video.uploaderStats = ctx.uploaderStats || null;
            video.uploaderEnforcement = ctx.uploaderEnforcement || null;
            if (!video.detailedCategories && ctx.detailedCategories) {
              video.detailedCategories = ctx.detailedCategories;
            }
            // Re-render the event meta section
            const metaEl = card.querySelector('.event-meta');
            const infoEl = card.querySelector('.video-info');
            if (infoEl && !metaEl) {
              const newMetaHTML = createEventMetaHTML(video);
              if (newMetaHTML) {
                infoEl.insertAdjacentHTML('afterbegin', newMetaHTML);
              }
            }
            // Render uploader stats if now available
            const uploaderContainer = card.querySelector('.uploader-context');
            if (uploaderContainer && (ctx.uploaderStats || ctx.uploaderEnforcement)) {
              uploaderContainer.innerHTML = createUploaderContextInner(video);
            }
          }
        });
      }
```

- [ ] **Step 3: Similarly update preloadNext to store enriched data**

In `preloadNext()`, update the `fetchVideoContext` callback (lines 788-796):

Replace:
```javascript
      if (!next.nostrContext && !next._nostrContextFetched) {
        next._nostrContextFetched = true;
        fetchVideoContext(next.sha256).then(ctx => {
          if (ctx) {
            next.nostrContext = ctx.nostrContext || null;
            next.eventId = next.eventId || ctx.eventId || null;
            next.uploaded_by = next.uploaded_by || ctx.uploaded_by || null;
          }
        });
      }
```

With:
```javascript
      if (!next.nostrContext && !next._nostrContextFetched) {
        next._nostrContextFetched = true;
        fetchVideoContext(next.sha256).then(ctx => {
          if (ctx) {
            next.nostrContext = ctx.nostrContext || null;
            next.eventId = next.eventId || ctx.eventId || null;
            next.uploaded_by = next.uploaded_by || ctx.uploaded_by || null;
            next.uploaderStats = ctx.uploaderStats || null;
            next.uploaderEnforcement = ctx.uploaderEnforcement || null;
            if (!next.detailedCategories && ctx.detailedCategories) {
              next.detailedCategories = ctx.detailedCategories;
            }
          }
        });
      }
```

- [ ] **Step 4: Add realness fetch and submit functions**

Add after the `fetchTranscriptData` function (after line 897):

```javascript
    async function fetchRealnessResult(sha256) {
      try {
        const resp = await fetch(`/admin/api/realness/${sha256}`);
        if (resp.status === 404) return null;
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    }

    async function submitForAIVerification(sha256) {
      try {
        const resp = await fetch(`/admin/api/realness/${sha256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (err) {
        console.error('[QuickReview] AI verification submit failed:', err);
        return { submitted: false, error: err.message };
      }
    }
```

- [ ] **Step 5: Add realness loading in showCurrentVideo**

Add after the transcript loading block (after the closing `}` on line 739), before the nostr context block:

```javascript
      // Async-load realness (secondary AI verification) for videos with high AI scores
      const aiScore = (video.scores?.ai_generated || 0);
      const deepfakeScore = (video.scores?.deepfake || 0);
      if ((aiScore >= 0.3 || deepfakeScore >= 0.3) && !video._realnessLoaded) {
        video._realnessLoaded = true;
        fetchRealnessResult(video.sha256).then(result => {
          if (currentIndex < reviewQueue.length && reviewQueue[currentIndex].sha256 === video.sha256) {
            video.realnessResult = result;
            const container = card.querySelector('.realness-panel');
            if (container) {
              container.innerHTML = createRealnessHTML(result, video.sha256);
            }
          }
        });
      }
```

- [ ] **Step 6: Commit**

```bash
git add src/admin/swipe-review.html
git commit -m "feat: pass through full lookup data and add realness fetch/submit functions"
```

---

## Chunk 3: Frontend — Add CSS and rendering functions

### Task 3: Add CSS styles for new panels

**Files:**
- Modify: `src/admin/swipe-review.html:457-467` (insert CSS before `.keyboard-hints kbd`)

- [ ] **Step 1: Add CSS for realness panel, uploader context, and verify button**

Insert before line 457 (`.keyboard-hints kbd`):

```css
    .realness-panel {
      background: #111;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }

    .realness-verdict {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .realness-verdict.authentic { color: #22c55e; }
    .realness-verdict.likely_ai { color: #ef4444; }
    .realness-verdict.disputed { color: #f59e0b; }
    .realness-verdict.uncertain { color: #888; }
    .realness-verdict.pending { color: #666; }

    .realness-providers {
      font-size: 11px;
      color: #888;
      margin-top: 4px;
    }

    .realness-providers span {
      margin-right: 12px;
    }

    .uploader-context {
      background: #111;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }

    .uploader-context-header {
      font-size: 11px;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-bottom: 6px;
    }

    .uploader-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
    }

    .uploader-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .uploader-badge.risk-high {
      background: #7f1d1d;
      color: #fca5a5;
    }

    .uploader-badge.risk-elevated {
      background: #78350f;
      color: #fcd34d;
    }

    .uploader-badge.approval {
      background: #1e3a5f;
      color: #93c5fd;
    }

    .uploader-badge.relay-ban {
      background: #7f1d1d;
      color: #fca5a5;
    }

    .uploader-badge.clean {
      background: #14532d;
      color: #86efac;
    }

    .uploader-stats {
      font-size: 11px;
      color: #888;
    }

    .action-btn.verify {
      background: #1e3a5f;
      color: #93c5fd;
    }

    .action-btn.verify:hover {
      background: #1e40af;
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/admin/swipe-review.html
git commit -m "feat: add CSS styles for realness panel, uploader context, and verify button"
```

### Task 4: Add rendering functions for realness and uploader context

**Files:**
- Modify: `src/admin/swipe-review.html` (add functions after `createClassifierHTML`, before `createVideoCard`)

- [ ] **Step 1: Add createRealnessHTML function**

Insert after the `createClassifierHTML` function (after line 989), before `createVideoCard`:

```javascript
    function createRealnessHTML(result, sha256) {
      if (!result) {
        return `<div style="font-size: 12px; color: #666;">Loading secondary verification...</div>`;
      }

      const verdictLabels = {
        authentic: 'AUTHENTIC',
        likely_ai: 'LIKELY AI',
        disputed: 'DISPUTED (providers disagree)',
        uncertain: 'UNCERTAIN',
        pending: 'PENDING...'
      };

      const verdict = result.overallVerdict || 'pending';
      let html = `<div class="realness-verdict ${verdict}">Secondary: ${verdictLabels[verdict] || verdict}</div>`;

      // Show per-provider details, skipping Hive (already shown in scores)
      const providerDetails = [];
      for (const [name, info] of Object.entries(result.providers || {})) {
        if (name === 'hive') continue;
        const label = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (info.status === 'complete') {
          const scoreStr = info.score != null ? ` ${(info.score * 100).toFixed(0)}%` : '';
          const color = info.verdict === 'authentic' ? '#22c55e' : info.verdict === 'likely_ai' ? '#ef4444' : '#888';
          providerDetails.push(`<span style="color:${color}">${label}: ${info.verdict}${scoreStr}</span>`);
        } else if (info.status === 'pending') {
          providerDetails.push(`<span style="color:#666">${label}: pending</span>`);
        } else if (info.status === 'error') {
          providerDetails.push(`<span style="color:#666">${label}: error</span>`);
        }
      }

      if (providerDetails.length > 0) {
        html += `<div class="realness-providers">${providerDetails.join(' · ')}</div>`;
      }

      if (result.completedAt) {
        html += `<div style="font-size: 10px; color: #555; margin-top: 4px;">Verified: ${formatTimeAgo(result.completedAt)}</div>`;
      }

      return html;
    }

    function createUploaderContextInner(video) {
      const stats = video.uploaderStats;
      const enforcement = video.uploaderEnforcement;

      if (!stats && !enforcement) {
        return '<div style="font-size: 11px; color: #555;">Loading user info...</div>';
      }

      const badges = [];
      if (enforcement?.approval_required) {
        badges.push('<span class="uploader-badge approval">Approval Required</span>');
      }
      if (enforcement?.relay_banned) {
        badges.push('<span class="uploader-badge relay-ban">Relay Banned</span>');
      }
      if (stats?.risk_level === 'high') {
        badges.push('<span class="uploader-badge risk-high">High Risk</span>');
      } else if (stats?.risk_level === 'elevated') {
        badges.push('<span class="uploader-badge risk-elevated">Elevated Risk</span>');
      }
      if (badges.length === 0) {
        badges.push('<span class="uploader-badge clean">Clean</span>');
      }

      const statBits = [];
      if (stats) {
        if (stats.total_count != null) statBits.push(`${stats.total_count} videos`);
        if (stats.flagged_count) statBits.push(`${stats.flagged_count} flagged`);
        if (stats.restricted_count) statBits.push(`${stats.restricted_count} restricted`);
        if (stats.banned_count) statBits.push(`${stats.banned_count} banned`);
      }

      return `
        <div class="uploader-context-header">User History</div>
        <div class="uploader-badges">${badges.join('')}</div>
        ${statBits.length > 0 ? `<div class="uploader-stats">${statBits.join(' · ')}</div>` : ''}
      `;
    }

    function createUploaderContextHTML(video) {
      return `<div class="uploader-context">${createUploaderContextInner(video)}</div>`;
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/admin/swipe-review.html
git commit -m "feat: add rendering functions for realness and uploader context panels"
```

---

## Chunk 4: Frontend — Update card template and keyboard shortcut

### Task 5: Update createVideoCard to include new panels and Verify AI button

**Files:**
- Modify: `src/admin/swipe-review.html:1095-1148` (the return template in createVideoCard)

- [ ] **Step 1: Update the card template**

Replace the card template (lines 1095-1148) with:

```javascript
      // Determine if we should show the Verify AI button
      const hasHighAI = (scores.ai_generated >= 0.3 || scores.deepfake >= 0.3);
      const hasRealnessResult = Boolean(video.realnessResult);
      const showVerifyButton = hasHighAI && !hasRealnessResult && !isUntriaged;

      // Realness panel (only for videos with AI flags)
      const realnessHTML = hasHighAI
        ? `<div class="realness-panel">${hasRealnessResult ? createRealnessHTML(video.realnessResult, sha256) : '<div style="font-size: 12px; color: #666;">No secondary verification yet</div>'}</div>`
        : '';

      // Uploader context panel
      const uploaderContextHTML = createUploaderContextHTML(video);

      return `
        <div class="video-card-swipe" data-sha256="${sha256}" data-untriaged="${isUntriaged ? 'true' : 'false'}">
          <div class="swipe-indicator left">✗</div>
          <div class="swipe-indicator right">✓</div>
          <div class="swipe-indicator up">⚠</div>

          ${untriagedBanner}

          <div class="video-wrapper">
            <video src="${videoUrl}" controls loop preload="auto"></video>
          </div>

          <div class="video-info">
            ${eventMetaHTML}

            ${uploaderContextHTML}

            ${title ? `<div class="nostr-title" style="margin-bottom: 10px;">${escapeHtml(title)}</div>` : ''}

            <div class="video-hash" style="display: flex; align-items: center; gap: 8px;">
              ${sha256}
              <button onclick="copyPermalink('${sha256}', this)" style="background: none; border: 1px solid #555; color: #aaa; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;">📋 Link</button>
            </div>

            ${classifierHTML}

            <div class="transcript-panel">${transcriptHTML}</div>

            ${scoreEntries.length > 0 ? `
              <div class="scores-grid">
                ${scoresHTML}
              </div>
            ` : (isUntriaged ? '<div style="color: #888; font-size: 13px; margin-bottom: 10px;">No moderation scores yet - will be analyzed after queuing</div>' : '')}

            ${realnessHTML}

            ${providerHTML}
            ${aiSourceHTML}
            ${nostrStatsHTML}

            <div class="action-buttons">
              <button class="action-btn ban" onclick="handleAction('${sha256}', 'PERMANENT_BAN')">
                Ban
              </button>
              <button class="action-btn age-restrict" onclick="handleAction('${sha256}', 'AGE_RESTRICTED')">
                Age-Restrict
              </button>
              <button class="action-btn approve" onclick="handleAction('${sha256}', 'SAFE')">
                Approve
              </button>
              ${showVerifyButton ? `
              <button class="action-btn verify" onclick="handleVerifyAI('${sha256}')">
                Verify AI
              </button>
              ` : ''}
            </div>

            <div class="keyboard-hints">
              <kbd>←</kbd> Ban &nbsp;·&nbsp; <kbd>↑</kbd> Age-Restrict &nbsp;·&nbsp; <kbd>→</kbd> Approve &nbsp;·&nbsp; <kbd>Space</kbd> Skip${showVerifyButton ? ' &nbsp;·&nbsp; <kbd>v</kbd> Verify AI' : ''}
            </div>
          </div>
        </div>
      `;
```

- [ ] **Step 2: Commit**

```bash
git add src/admin/swipe-review.html
git commit -m "feat: add realness panel, uploader context, and verify button to card template"
```

### Task 6: Add handleVerifyAI function and keyboard shortcut

**Files:**
- Modify: `src/admin/swipe-review.html` (add function before `skipVideo`, update keyboard handler)

- [ ] **Step 1: Add handleVerifyAI function**

Insert before the `skipVideo` function (before line 1321):

```javascript
    async function handleVerifyAI(sha256) {
      showToast('Submitting for AI verification...', null, 2000);

      const result = await submitForAIVerification(sha256);

      if (result.submitted) {
        showToast('Submitted for secondary AI verification — will appear in queue when results arrive', null, 3000);
      } else if (result.cached) {
        showToast('Already submitted for verification', null, 2000);
      } else {
        showToast('Verification failed: ' + (result.error || 'unknown error'), null, 3000);
        return; // Don't advance on error
      }

      // Advance to next video
      currentIndex++;
      showCurrentVideo();
    }
```

- [ ] **Step 2: Add 'v' keyboard shortcut**

In the keyboard handler (around line 1339), add a case for 'v' after the Space case:

```javascript
        case 'v':
        case 'V':
          e.preventDefault();
          const currentVideo = reviewQueue[currentIndex];
          const currentScores = currentVideo?.scores || {};
          if ((currentScores.ai_generated >= 0.3 || currentScores.deepfake >= 0.3) && !currentVideo.realnessResult && !currentVideo.isUntriaged) {
            handleVerifyAI(sha256);
          }
          break;
```

- [ ] **Step 3: Commit**

```bash
git add src/admin/swipe-review.html
git commit -m "feat: add handleVerifyAI function and 'v' keyboard shortcut"
```

---

## Summary of all changes

1. **`src/index.mjs`** — New POST `/admin/api/realness/:sha256` endpoint to trigger Reality Defender submission
2. **`src/admin/swipe-review.html`** — All frontend changes:
   - CSS for realness panel, uploader context, verify button
   - `fetchVideoContext` returns full enriched data (uploaderStats, uploaderEnforcement, detailedCategories)
   - `fetchRealnessResult()` and `submitForAIVerification()` functions
   - `createRealnessHTML()` renders verdict with per-provider breakdown
   - `createUploaderContextHTML()` renders user history badges and stats
   - Card template updated with new panels and "Verify AI" button
   - `handleVerifyAI()` submits and advances
   - `v` keyboard shortcut for verify
