// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for user report system (reports.mjs)
// ABOUTME: Verifies D1-backed report storage, deduplication, and escalation thresholds

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { initReportsTable, addReport, getReportCount, getReporterPubkeys } from './reports.mjs';

const SHA256 = ('a'.repeat(63) + '1').slice(0, 64);
const REPORTER1 = ('b'.repeat(63) + '1').slice(0, 64);
const REPORTER2 = ('b'.repeat(63) + '2').slice(0, 64);
const REPORTER3 = ('b'.repeat(63) + '3').slice(0, 64);
const REPORTER4 = ('b'.repeat(63) + '4').slice(0, 64);
const REPORTER5 = ('b'.repeat(63) + '5').slice(0, 64);

describe('reports', () => {
  const db = env.BLOSSOM_DB;

  beforeEach(async () => {
    await initReportsTable(db);
    await db.prepare('DELETE FROM user_reports').run();
  });

  describe('addReport', () => {
    it('should add a new report and not escalate', async () => {
      const result = await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'nudity',
        reason: 'inappropriate content',
      });

      expect(result).toEqual({ escalate: null });
    });

    it('should deduplicate same reporter for same sha256', async () => {
      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'nudity',
      });

      // Same reporter, same sha256 — should not increase count
      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'spam',
        reason: 'duplicate report',
      });

      const count = await getReportCount(db, SHA256);
      expect(count).toBe(1);
    });

    it('should count different reporters separately', async () => {
      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'nudity',
      });

      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER2,
        report_type: 'nudity',
      });

      const count = await getReportCount(db, SHA256);
      expect(count).toBe(2);
    });
  });

  describe('escalation thresholds', () => {
    it('should escalate to REVIEW at 3 unique reporters', async () => {
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER2, report_type: 'nudity' });

      const result = await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER3,
        report_type: 'nudity',
      });

      expect(result).toEqual({ escalate: 'REVIEW' });
    });

    it('should escalate to AGE_RESTRICTED at 5 unique reporters', async () => {
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER2, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER3, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER4, report_type: 'nudity' });

      const result = await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER5,
        report_type: 'nudity',
      });

      expect(result).toEqual({ escalate: 'AGE_RESTRICTED' });
    });
  });

  describe('getReportCount', () => {
    it('should return 0 for unreported sha256', async () => {
      const unreportedSha256 = ('c'.repeat(63) + '1').slice(0, 64);
      const count = await getReportCount(db, unreportedSha256);
      expect(count).toBe(0);
    });
  });

  describe('getReporterPubkeys', () => {
    it('should return empty array for unreported sha256', async () => {
      const reporters = await getReporterPubkeys(db, ('c'.repeat(63) + '1').slice(0, 64));
      expect(reporters).toEqual([]);
    });

    it('should return unique reporters with report dates', async () => {
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER2, report_type: 'nudity' });
      // Duplicate from REPORTER1 -- should not appear twice
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'spam' });

      const reporters = await getReporterPubkeys(db, SHA256);
      expect(reporters).toHaveLength(2);
      const pubkeys = reporters.map(r => r.pubkey);
      expect(pubkeys).toContain(REPORTER1);
      expect(pubkeys).toContain(REPORTER2);
      // Each reporter should have a reportedAt date
      for (const r of reporters) {
        expect(r.reportedAt).toBeTruthy();
      }
    });

    it('should not return reporters for different sha256', async () => {
      const otherSha256 = ('d'.repeat(63) + '1').slice(0, 64);
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await addReport(db, { sha256: otherSha256, reporter_pubkey: REPORTER2, report_type: 'nudity' });

      const reporters = await getReporterPubkeys(db, SHA256);
      expect(reporters).toHaveLength(1);
      expect(reporters[0].pubkey).toBe(REPORTER1);
    });
  });
});
