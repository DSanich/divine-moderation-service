// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Vitest configuration for testing Cloudflare Workers
// ABOUTME: Uses @cloudflare/vitest-pool-workers for Workers environment simulation

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: './wrangler.toml' },
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.mjs'],
      exclude: ['src/**/*.test.mjs', 'src/admin/*.html'],
    },
  },
});
