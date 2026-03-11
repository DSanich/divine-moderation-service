# DM System — Remaining Gaps Implementation Plan

## Gap 1: Category-Specific Message Templates with Policy Links

**Problem:** Current templates are generic one-liners. Creators get "Reason: nudity" with no context about what policy was violated or how to appeal.

**File:** `src/nostr/dm-sender.mjs`

### Changes

Replace the flat `TEMPLATES` object (lines 31-43) with a richer template system:

```js
const CATEGORY_TEMPLATES = {
  nudity: {
    reason: 'sexual or nude content',
    policy: 'https://divine.video/policies#sexual-content',
  },
  ai_generated: {
    reason: 'AI-generated content without disclosure',
    policy: 'https://divine.video/policies#ai-content',
  },
  deepfake: {
    reason: 'deepfake or manipulated media',
    policy: 'https://divine.video/policies#manipulated-media',
  },
  offensive: {
    reason: 'offensive or hateful content',
    policy: 'https://divine.video/policies#hate-speech',
  },
  self_harm: {
    reason: 'content depicting self-harm',
    policy: 'https://divine.video/policies#self-harm',
    extra: '\n\nIf you or someone you know is struggling, please reach out: 988 Suicide & Crisis Lifeline (call or text 988).',
  },
  scam: {
    reason: 'fraudulent or scam content',
    policy: 'https://divine.video/policies#fraud',
  },
};
```

Add a `selectTemplate(action, reason, categories)` function:

```js
export function selectTemplate(action, reason, categories) {
  // Try to match a specific category
  let categoryInfo = null;
  if (categories && typeof categories === 'string') {
    try {
      const parsed = JSON.parse(categories);
      // categories is stored as JSON object with category keys
      for (const cat of Object.keys(parsed)) {
        if (CATEGORY_TEMPLATES[cat]) {
          categoryInfo = CATEGORY_TEMPLATES[cat];
          break;
        }
      }
    } catch { /* not JSON, try as plain string */ }
    if (!categoryInfo && CATEGORY_TEMPLATES[categories]) {
      categoryInfo = CATEGORY_TEMPLATES[categories];
    }
  }

  const specificReason = categoryInfo?.reason || reason || 'content policy violation';
  const policyLink = categoryInfo?.policy || 'https://divine.video/policies';
  const extra = categoryInfo?.extra || '';

  const templates = {
    PERMANENT_BAN: `Your video has been removed for: ${specificReason}.\n\nPolicy: ${policyLink}\n\nIf you believe this is an error, reply to this message to appeal.${extra}`,
    AGE_RESTRICTED: `Your video has been age-restricted: ${specificReason}. It remains available but will only be shown to users who have confirmed their age.\n\nPolicy: ${policyLink}`,
    QUARANTINE: `Your video has been temporarily hidden pending review: ${specificReason}. A moderator will review it shortly — you can reply with context.\n\nPolicy: ${policyLink}`,
  };

  return templates[action] || null;
}
```

Update `sendModerationDM()` to accept and use `categories`:

```js
export async function sendModerationDM(recipientPubkey, sha256, action, reason, env, ctx, categories) {
  // ... existing validation ...
  const message = selectTemplate(action, reason, categories);
  // (instead of TEMPLATES[action](reason))
```

Update callsite in `handleModerationResult()` (index.mjs ~line 2690):

```js
await sendModerationDM(uploadedBy, sha256, action, reason, env, null, result.categories);
```

And in admin manual moderate (~line 921):

```js
// Fetch categories from D1 for the template
const catRow = await env.BLOSSOM_DB.prepare('SELECT categories FROM moderation_results WHERE sha256 = ?').bind(sha256).first();
await sendModerationDM(uploaderRow.uploaded_by, sha256, action, reason, env, null, catRow?.categories);
```

**Keep the old `getMessageForAction()` as-is** for backward compat with tests — just have `sendModerationDM` prefer `selectTemplate` over it.

### Test updates

Add tests in `dm-sender.test.mjs`:
- `selectTemplate('PERMANENT_BAN', null, '{"nudity": 0.95}')` → contains "sexual" and policy link
- `selectTemplate('PERMANENT_BAN', null, '{"self_harm": 0.8}')` → contains crisis hotline
- `selectTemplate('QUARANTINE', 'custom reason', null)` → falls back to custom reason
- `selectTemplate('PERMANENT_BAN', null, null)` → uses default "content policy violation"

---

## Gap 2: User Profile Resolution (Kind 0 Metadata)

**Problem:** The messages UI shows raw hex pubkeys like `a1b2c3d4...` instead of display names/avatars.

### New file: `src/nostr/profile-resolver.mjs`

```js
/**
 * Resolve Nostr profile (kind 0) for a pubkey.
 * Returns { name, display_name, picture, nip05 } or null.
 * Cached in KV for 1 hour.
 */
export async function resolveProfile(pubkey, env) {
  // 1. Check KV cache
  const cacheKey = `profile:${pubkey}`;
  if (env.MODERATION_KV) {
    const cached = await env.MODERATION_KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  // 2. Query relay.divine.video for kind 0
  //    Same WebSocket pattern as queryRelayList() in dm-sender.mjs
  //    Filter: { kinds: [0], authors: [pubkey], limit: 1 }
  //    Parse event.content as JSON -> extract name, display_name, picture, nip05

  // 3. Cache result in KV (1hr TTL, cache nulls as empty object to avoid re-querying)

  // 4. Return profile object or null
}

/**
 * Batch resolve profiles for multiple pubkeys.
 * Queries relay once with authors=[...pubkeys].
 */
export async function resolveProfiles(pubkeys, env) {
  // Check KV cache for each, collect misses
  // Query relay for all misses in one REQ
  // Cache results, return map of pubkey -> profile
}
```

### API endpoint: `GET /admin/api/profiles?pubkeys=aaa,bbb,ccc`

Add in `src/index.mjs` (after the messages endpoints, ~line 1851):

```js
if (url.pathname === '/admin/api/profiles' && request.method === 'GET') {
  const authError = await requireAuth(request, env);
  if (authError) return authError;

  const pubkeys = (url.searchParams.get('pubkeys') || '').split(',').filter(Boolean).slice(0, 50);
  const { resolveProfiles } = await import('./nostr/profile-resolver.mjs');
  const profiles = await resolveProfiles(pubkeys, env);
  return new Response(JSON.stringify(profiles), { headers: { 'Content-Type': 'application/json' } });
}
```

### Frontend changes (messages.html)

After fetching conversations, call `/admin/api/profiles?pubkeys=...` with all participant pubkeys, then update the UI:

```js
let profileCache = {};

async function fetchProfiles(pubkeys) {
  if (!pubkeys.length) return;
  const unique = [...new Set(pubkeys)].filter(p => !profileCache[p]);
  if (!unique.length) return;
  const res = await fetch('/admin/api/profiles?pubkeys=' + unique.join(','));
  if (res.ok) {
    const data = await res.json();
    Object.assign(profileCache, data);
  }
}
```

Update `renderConversations()` to show display name + small avatar instead of truncated hex:

```js
const profile = profileCache[pubkey];
const displayName = profile?.display_name || profile?.name || truncatePubkey(pubkey);
const avatar = profile?.picture
  ? `<img src="${profile.picture}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;">`
  : '';
```

Update `thread-pubkey` header to show full profile info.

---

## Gap 3: Search by Name in Messages UI

**Problem:** No way to find a conversation except scrolling.

### Frontend-only change (messages.html)

Add a search input above the conversation list:

```html
<div class="conversation-list-header">
  <span>Conversations</span>
  <input type="text" id="search-input" placeholder="Search by name or pubkey..."
    oninput="filterConversations(this.value)">
</div>
```

Add CSS for the search input (compact, fits in header).

Add filter function:

```js
function filterConversations(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    renderConversations();
    return;
  }

  const filtered = conversations.filter(conv => {
    const pubkey = conv.participant_pubkey || conv.pubkey || '';
    const profile = profileCache[pubkey];
    const name = (profile?.display_name || profile?.name || '').toLowerCase();
    const nip05 = (profile?.nip05 || '').toLowerCase();
    return pubkey.includes(q) || name.includes(q) || nip05.includes(q);
  });

  renderConversationList(filtered);
}
```

Split `renderConversations()` so it can take an optional filtered list:

```js
function renderConversations() {
  renderConversationList(conversations);
}

function renderConversationList(list) {
  // ... existing render logic, using `list` instead of `conversations`
}
```

This is purely client-side filtering — no backend changes needed since profiles are already fetched for display.

---

## Gap 4: "Message Creator" Link on Video Detail Cards

**Problem:** When reviewing a video, there's no quick way to message the uploader.

### Backend: Include `uploaded_by` in decisions query

Update the SELECT in the decisions list endpoint (~line 2066):

```sql
SELECT sha256, action, provider, scores, moderated_at, reviewed_by, reviewed_at, uploaded_by
FROM moderation_results
```

### Frontend: Add link in dashboard.html video cards

In the `renderVideoCard()` function (~line 2360, after the "View on divine.video" link):

```js
${video.uploaded_by ? `
  <div class="divine-link">
    <a href="/admin/messages?pubkey=${video.uploaded_by}" target="_blank" rel="noopener noreferrer">
      Message Creator →
    </a>
  </div>
` : ''}
```

### Messages page: Handle `?pubkey=` query param

In `messages.html`, at init time:

```js
// Check for pre-selected pubkey from URL
const urlParams = new URLSearchParams(window.location.search);
const preselectedPubkey = urlParams.get('pubkey');

async function init() {
  await fetchConversations();
  if (preselectedPubkey) {
    await selectConversation(preselectedPubkey);
  }
}

init();
```

This replaces the current bare `fetchConversations()` call at the bottom. If the pubkey has no existing conversation, `selectConversation` will show an empty thread — the moderator can still compose a new message.

---

## Implementation Order

1. **Gap 2 (Profile resolver)** — needed by Gap 3 (search needs names to search)
2. **Gap 3 (Search)** — purely frontend, quick once profiles work
3. **Gap 1 (Category templates)** — backend only, independent
4. **Gap 4 (Message Creator link)** — small changes in both dashboard.html and messages.html

Total: ~4 files modified, 1 new file created. No new dependencies.
