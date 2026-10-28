import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('./entrypoint.ts', import.meta.url)),
      wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
      miniflare: {
        name: 'yoneda-test',
        compatibilityDate: '2026-10-07',
        compatibilityFlags: ['nodejs_compat'],
        r2Buckets: ['OBJECTS'],
        d1Databases: ['INDEX'],
        bindings: {
          OWNER_TOKEN: 'local-test-owner',
          ARTIFACTS_NAMESPACE: 'yoneda-test',
          PLATFORM_OBJECT_STORE: 'r2',
        },
      },
    }),
  ],
  // Module cache per checkout: worktrees share one symlinked node_modules, its default home.
  test: {
    fsModuleCachePath: fileURLToPath(new URL('../../.vitest/module-cache', import.meta.url)),
    include: ['tests/workers/**/*.test.ts'],
    setupFiles: ['tests/workers/platform-listing.ts'],
    // GitHub runners (4 vCPU, four workerd pools) run this suite about 8x slower than a
    // workstation; repo-tiers needed over 20 s there. The limit is a hang guard only.
    testTimeout: process.env.CI ? 60_000 : 20_000,
    // One workerd per worker: cap it so parallel builders don't saturate the machine.
    maxWorkers: 4,
  },
});
