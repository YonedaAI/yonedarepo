import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('./apps-canary-entrypoint.ts', import.meta.url)),
      miniflare: {
        compatibilityDate: '2026-10-12',
        workerLoaders: { LOADER: {} },
        durableObjects: { CANARY: { className: 'Canary', useSQLite: true } },
      },
    }),
  ],
  test: { include: ['tests/workers/apps-canary.test.ts'], testTimeout: 20000 },
});
