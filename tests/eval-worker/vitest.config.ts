// The eval Worker's suite: fake model endpoints only (no keys, no paid inference).
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('./entrypoint.ts', import.meta.url)),
      wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
      miniflare: { name: 'yoneda-eval-test', compatibilityDate: '2026-10-07', compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
  test: { include: ['tests/eval-worker/**/*.test.ts'], testTimeout: 60_000 },
});
