// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import dashboardHTML from './dashboard.html';

describe('dashboard provenance UI hooks', () => {
  it('contains creator info modal and provenance helpers', () => {
    expect(dashboardHTML).toContain('Creator Info');
    expect(dashboardHTML).toContain('openCreatorInfo');
    expect(dashboardHTML).toContain('renderProvenanceBadge');
    expect(dashboardHTML).toContain('creator-info-modal');
  });

  it('contains C2PA/ProofMode badge rendering', () => {
    expect(dashboardHTML).toContain('renderC2paBadge');
    expect(dashboardHTML).toContain('formatC2paSupportLine');
    expect(dashboardHTML).toContain('Valid ProofMode');
    expect(dashboardHTML).toContain('Valid C2PA');
    expect(dashboardHTML).toContain('Valid but AI-signed');
    expect(dashboardHTML).toContain('Invalid Proof');
    expect(dashboardHTML).toContain('c2pa-badge');
  });
});
