// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// ABOUTME: Builds webhook payloads for ATProto label emission
// ABOUTME: Called after moderation results to notify the Rust labeler service

const LABEL_THRESHOLD = 0.5;

/**
 * Build a webhook payload to send to the ATProto labeler service.
 * Returns null if no labels should be emitted (SAFE result).
 */
export function buildLabelWebhookPayload(result) {
  const signalScores = result.downstreamSignals?.scores || result.scores || {};
  const hasExplicitSignals = result.downstreamSignals?.hasSignals === true;
  if (result.action === 'SAFE' && !hasExplicitSignals) return null;

  const labels = [];
  for (const [category, score] of Object.entries(signalScores)) {
    if (score >= LABEL_THRESHOLD) {
      labels.push({ category, score });
    }
  }

  return {
    sha256: result.sha256,
    action: result.action,
    labels,
    reviewed_by: result.reviewed_by || null,
    timestamp: new Date().toISOString(),
    nostr_event_id: result.nostr_event_id || result.eventId || null,
  };
}

/**
 * Send moderation result to the ATProto labeler service webhook.
 * Fire-and-forget: logs errors but doesn't throw.
 */
export async function notifyAtprotoLabeler(result, env) {
  if (!env.ATPROTO_LABELER_WEBHOOK_URL) return;

  const payload = buildLabelWebhookPayload(result);
  if (!payload) return;

  try {
    const resp = await fetch(env.ATPROTO_LABELER_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ATPROTO_LABELER_TOKEN || ''}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`[ATPROTO] Labeler webhook failed: ${resp.status}`);
    }
  } catch (err) {
    console.error(`[ATPROTO] Labeler webhook error: ${err.message}`);
  }
}
