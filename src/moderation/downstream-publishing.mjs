// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Builds downstream moderation publishing payloads from moderation results
// ABOUTME: Separates public enforcement actions from non-blocking moderation signal publishing

function actionToReportType(action) {
  return (action || 'review').toLowerCase().replace('_', '-');
}

export function buildDownstreamPublishContext(result) {
  const filteredScores = result.downstreamSignals?.scores || result.scores || {};
  const hasExplicitSignals = result.downstreamSignals?.hasSignals === true;
  const publishReport = result.action !== 'SAFE' || hasExplicitSignals;

  const labelResult = {
    ...result,
    scores: filteredScores
  };

  return {
    publishReport,
    reportData: publishReport ? {
      type: result.action !== 'SAFE' ? actionToReportType(result.action) : 'review',
      sha256: result.sha256,
      cdnUrl: result.cdnUrl,
      category: result.downstreamSignals?.category || result.category,
      scores: filteredScores,
      reason: result.downstreamSignals?.reason || result.reason,
      severity: result.downstreamSignals?.severity || result.severity,
      frames: result.flaggedFrames
    } : null,
    labelResult,
  };
}
