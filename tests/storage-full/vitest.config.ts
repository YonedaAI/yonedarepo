import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The workerd suite's setup with the `experimental` flag, which adds SqlStorage's
// setMaxPageCountForTest: apart, so no other test runs on experimental behaviour.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('../workers/entrypoint.ts', import.meta.url)),
      wrangler: { configPath: fileURLToPath(new URL('../workers/wrangler.jsonc', import.meta.url)) },
      miniflare: {
        name: 'yoneda-test',
        compatibilityDate: '2026-10-07',
        compatibilityFlags: ['nodejs_compat', 'experimental'],
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
  test: {
    fsModuleCachePath: fileURLToPath(new URL('../../.vitest/module-cache-full', import.meta.url)),
    include: ['tests/storage-full/**/*.test.ts'],
    setupFiles: ['tests/workers/platform-listing.ts'],
    testTimeout: process.env.CI ? 60_000 : 20_000,
  },
});
