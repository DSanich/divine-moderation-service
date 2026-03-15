// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Stores uploader-level enforcement state for approval gating and relay bans

function normalizeRow(row) {
  if (!row) {
    return null;
  }

  return {
    pubkey: row.pubkey,
    approval_required: Boolean(row.approval_required),
    approval_reason: row.approval_reason || null,
    approval_updated_at: row.approval_updated_at || null,
    approval_updated_by: row.approval_updated_by || null,
    relay_banned: Boolean(row.relay_banned),
    relay_ban_reason: row.relay_ban_reason || null,
    relay_ban_updated_at: row.relay_ban_updated_at || null,
    relay_ban_updated_by: row.relay_ban_updated_by || null,
    notes: row.notes || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

export async function initUploaderEnforcementTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS uploader_enforcement (
      pubkey TEXT PRIMARY KEY,
      approval_required INTEGER DEFAULT 0,
      approval_reason TEXT,
      approval_updated_at TEXT,
      approval_updated_by TEXT,
      relay_banned INTEGER DEFAULT 0,
      relay_ban_reason TEXT,
      relay_ban_updated_at TEXT,
      relay_ban_updated_by TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_uploader_enforcement_approval
    ON uploader_enforcement(approval_required)
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_uploader_enforcement_relay
    ON uploader_enforcement(relay_banned)
  `).run();
}

export async function getUploaderEnforcement(db, pubkey) {
  if (!pubkey) {
    return null;
  }

  const row = await db.prepare(
    'SELECT * FROM uploader_enforcement WHERE pubkey = ?'
  ).bind(pubkey).first();

  return normalizeRow(row);
}

export async function setUploaderEnforcement(db, pubkey, updates) {
  const now = new Date().toISOString();
  const existing = await getUploaderEnforcement(db, pubkey);

  const next = {
    pubkey,
    approval_required: updates.approval_required ?? existing?.approval_required ?? false,
    approval_reason: updates.approval_required !== undefined
      ? (updates.approval_reason ?? (updates.approval_required ? existing?.approval_reason : null) ?? null)
      : (existing?.approval_reason ?? null),
    approval_updated_at: updates.approval_required !== undefined
      ? now
      : (existing?.approval_updated_at ?? null),
    approval_updated_by: updates.approval_required !== undefined
      ? (updates.updated_by ?? null)
      : (existing?.approval_updated_by ?? null),
    relay_banned: updates.relay_banned ?? existing?.relay_banned ?? false,
    relay_ban_reason: updates.relay_banned !== undefined
      ? (updates.relay_ban_reason ?? (updates.relay_banned ? existing?.relay_ban_reason : null) ?? null)
      : (existing?.relay_ban_reason ?? null),
    relay_ban_updated_at: updates.relay_banned !== undefined
      ? now
      : (existing?.relay_ban_updated_at ?? null),
    relay_ban_updated_by: updates.relay_banned !== undefined
      ? (updates.updated_by ?? null)
      : (existing?.relay_ban_updated_by ?? null),
    notes: updates.notes ?? existing?.notes ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };

  await db.prepare(`
    INSERT INTO uploader_enforcement (
      pubkey,
      approval_required,
      approval_reason,
      approval_updated_at,
      approval_updated_by,
      relay_banned,
      relay_ban_reason,
      relay_ban_updated_at,
      relay_ban_updated_by,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pubkey) DO UPDATE SET
      approval_required = excluded.approval_required,
      approval_reason = excluded.approval_reason,
      approval_updated_at = excluded.approval_updated_at,
      approval_updated_by = excluded.approval_updated_by,
      relay_banned = excluded.relay_banned,
      relay_ban_reason = excluded.relay_ban_reason,
      relay_ban_updated_at = excluded.relay_ban_updated_at,
      relay_ban_updated_by = excluded.relay_ban_updated_by,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).bind(
    next.pubkey,
    next.approval_required ? 1 : 0,
    next.approval_reason,
    next.approval_updated_at,
    next.approval_updated_by,
    next.relay_banned ? 1 : 0,
    next.relay_ban_reason,
    next.relay_ban_updated_at,
    next.relay_ban_updated_by,
    next.notes,
    next.created_at,
    next.updated_at
  ).run();

  return next;
}

export function applyUploaderEnforcementToResult(result, enforcement) {
  if (!result || !enforcement) {
    return { result, applied: false };
  }

  if (enforcement.relay_banned && result.action !== 'PERMANENT_BAN') {
    const nextResult = {
      ...result,
      action: 'PERMANENT_BAN',
      severity: 'high',
      reason: result.reason
        ? `${result.reason} | uploader relay-banned`
        : 'Uploader is relay-banned',
      rawResponse: {
        ...(result.rawResponse || {}),
        uploaderEnforcement: {
          relay_banned: true,
          originalAction: result.action
        }
      }
    };

    return { result: nextResult, applied: true, mode: 'relay_banned', previousAction: result.action };
  }

  if (
    enforcement.approval_required
    && !['QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(result.action)
  ) {
    const nextResult = {
      ...result,
      action: 'QUARANTINE',
      severity: result.severity === 'high' ? result.severity : 'medium',
      reason: result.reason
        ? `${result.reason} | uploader requires manual approval`
        : 'Uploader requires manual approval',
      rawResponse: {
        ...(result.rawResponse || {}),
        uploaderEnforcement: {
          approval_required: true,
          originalAction: result.action
        }
      }
    };

    return { result: nextResult, applied: true, mode: 'approval_required', previousAction: result.action };
  }

  return { result, applied: false };
}
