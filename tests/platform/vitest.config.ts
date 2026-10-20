// The platform suites against the platform-only Worker: no RepositoryAuthority, agent
// queues, execution containers or provider keys are bound.
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('./entrypoint.ts', import.meta.url)),
      wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
      miniflare: { name: 'yoneda-platform-test', compatibilityDate: '2026-10-07', compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
  // Module cache per checkout: worktrees share one symlinked node_modules, its default home.
  test: {
    fsModuleCachePath: fileURLToPath(new URL('../../.vitest/module-cache', import.meta.url)),
    include: ['tests/workers/repo-*.test.ts', 'tests/workers/load-platform.test.ts', 'tests/workers/eval-*.test.ts'],
    testTimeout: 60_000,
  },
});
