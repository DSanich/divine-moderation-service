// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import swipeReviewHTML from './swipe-review.html';

describe('swipe review provenance UI hooks', () => {
  it('contains creator info modal and provenance helpers', () => {
    expect(swipeReviewHTML).toContain('Creator Info');
    expect(swipeReviewHTML).toContain('openCreatorInfo');
    expect(swipeReviewHTML).toContain('renderProvenanceBadge');
    expect(swipeReviewHTML).toContain('creator-info-modal');
  });
});
