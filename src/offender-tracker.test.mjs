// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for offender tracker — per-pubkey moderation stats and risk levels

import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  initOffenderTable,
  updateUploaderStats,
  getUploaderStats,
  getUploaderRiskLevel,
} from './offender-tracker.mjs';

const PUBKEY_1 = ('b'.repeat(63) + '1').slice(0, 64);
const PUBKEY_2 = ('b'.repeat(63) + '2').slice(0, 64);
const PUBKEY_UNKNOWN = ('f'.repeat(63) + '9').slice(0, 64);

describe('offender-tracker', () => {
  beforeEach(async () => {
    const db = env.BLOSSOM_DB;
    await initOffenderTable(db);
    // Clear all rows between tests
    await db.prepare('DELETE FROM uploader_stats').run();
  });

  describe('updateUploaderStats', () => {
    it('creates a row on first scan with SAFE action', async () => {
      const db = env.BLOSSOM_DB;
      const row = await updateUploaderStats(db, PUBKEY_1, 'SAFE');

      expect(row.pubkey).toBe(PUBKEY_1);
      expect(row.total_scanned).toBe(1);
      expect(row.flagged_count).toBe(0);
      expect(row.banned_count).toBe(0);
      expect(row.restricted_count).toBe(0);
      expect(row.review_count).toBe(0);
      expect(row.risk_level).toBe('normal');
      expect(row.last_flagged_at).toBeNull();
    });

    it('increments flagged_count and review_count for REVIEW', async () => {
      const db = env.BLOSSOM_DB;
      const row = await updateUploaderStats(db, PUBKEY_1, 'REVIEW');

      expect(row.total_scanned).toBe(1);
      expect(row.flagged_count).toBe(1);
      expect(row.review_count).toBe(1);
      expect(row.banned_count).toBe(0);
      expect(row.restricted_count).toBe(0);
      expect(row.last_flagged_at).not.toBeNull();
    });

    it('increments banned_count for PERMANENT_BAN', async () => {
      const db = env.BLOSSOM_DB;
      const row = await updateUploaderStats(db, PUBKEY_1, 'PERMANENT_BAN');

      expect(row.total_scanned).toBe(1);
      expect(row.flagged_count).toBe(1);
      expect(row.banned_count).toBe(1);
      expect(row.restricted_count).toBe(0);
      expect(row.review_count).toBe(0);
      expect(row.risk_level).toBe('high');
    });

    it('increments restricted_count for AGE_RESTRICTED', async () => {
      const db = env.BLOSSOM_DB;
      const row = await updateUploaderStats(db, PUBKEY_1, 'AGE_RESTRICTED');

      expect(row.total_scanned).toBe(1);
      expect(row.flagged_count).toBe(1);
      expect(row.restricted_count).toBe(1);
      expect(row.banned_count).toBe(0);
      expect(row.review_count).toBe(0);
    });

    it('accumulates counts across multiple updates', async () => {
      const db = env.BLOSSOM_DB;

      await updateUploaderStats(db, PUBKEY_1, 'SAFE');
      await updateUploaderStats(db, PUBKEY_1, 'REVIEW');
      await updateUploaderStats(db, PUBKEY_1, 'AGE_RESTRICTED');
      await updateUploaderStats(db, PUBKEY_1, 'AGE_RESTRICTED');
      const row = await updateUploaderStats(db, PUBKEY_1, 'PERMANENT_BAN');

      expect(row.total_scanned).toBe(5);
      expect(row.flagged_count).toBe(4); // REVIEW + 2x AGE_RESTRICTED + PERMANENT_BAN
      expect(row.review_count).toBe(1);
      expect(row.restricted_count).toBe(2);
      expect(row.banned_count).toBe(1);
      expect(row.risk_level).toBe('high');
    });
  });

  describe('getUploaderStats', () => {
    it('returns null for unknown pubkey', async () => {
      const db = env.BLOSSOM_DB;
      const stats = await getUploaderStats(db, PUBKEY_UNKNOWN);
      expect(stats).toBeNull();
    });

    it('returns full stats row for known pubkey', async () => {
      const db = env.BLOSSOM_DB;
      await updateUploaderStats(db, PUBKEY_1, 'REVIEW');

      const stats = await getUploaderStats(db, PUBKEY_1);
      expect(stats).not.toBeNull();
      expect(stats.pubkey).toBe(PUBKEY_1);
      expect(stats.total_scanned).toBe(1);
      expect(stats.review_count).toBe(1);
    });
  });

  describe('getUploaderRiskLevel', () => {
    it('returns "high" when banned_count > 0', async () => {
      const db = env.BLOSSOM_DB;
      await updateUploaderStats(db, PUBKEY_1, 'PERMANENT_BAN');

      const risk = await getUploaderRiskLevel(db, PUBKEY_1);
      expect(risk).toBe('high');
    });

    it('returns "high" when restricted_count >= 5', async () => {
      const db = env.BLOSSOM_DB;
      for (let i = 0; i < 5; i++) {
        await updateUploaderStats(db, PUBKEY_1, 'AGE_RESTRICTED');
      }

      const risk = await getUploaderRiskLevel(db, PUBKEY_1);
      expect(risk).toBe('high');
    });

    it('returns "elevated" when restricted_count >= 3', async () => {
      const db = env.BLOSSOM_DB;
      for (let i = 0; i < 3; i++) {
        await updateUploaderStats(db, PUBKEY_1, 'AGE_RESTRICTED');
      }

      const risk = await getUploaderRiskLevel(db, PUBKEY_1);
      expect(risk).toBe('elevated');
    });

    it('returns "normal" for clean record', async () => {
      const db = env.BLOSSOM_DB;
      await updateUploaderStats(db, PUBKEY_1, 'SAFE');

      const risk = await getUploaderRiskLevel(db, PUBKEY_1);
      expect(risk).toBe('normal');
    });

    it('returns "normal" for unknown pubkey', async () => {
      const db = env.BLOSSOM_DB;
      const risk = await getUploaderRiskLevel(db, PUBKEY_UNKNOWN);
      expect(risk).toBe('normal');
    });
  });
});
