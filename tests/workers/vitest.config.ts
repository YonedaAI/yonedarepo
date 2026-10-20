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
        durableObjects: {
          REPOSITORIES: { className: 'RepositoryAuthority', useSQLite: true },
          LIVE: { className: 'LiveRoom', useSQLite: true },
        },
        r2Buckets: ['OBJECTS'],
        d1Databases: ['INDEX'],
        bindings: {
          OWNER_TOKEN: 'local-test-owner',
          ARTIFACTS_NAMESPACE: 'yoneda-test',
          CODEX_MODEL: 'gpt-5.6-luna',
          CLAUDE_MODEL: 'claude-sonnet-5-5',
        },
      },
    }),
  ],
  // Module cache per checkout: worktrees share one symlinked node_modules, its default home.
  test: {
    fsModuleCachePath: fileURLToPath(new URL('../../.vitest/module-cache', import.meta.url)),
    include: ['tests/workers/**/*.test.ts'],
    exclude: ['tests/workers/apps-*.test.ts'],
    testTimeout: 20_000,
    // One workerd per worker: cap it so parallel builders don't saturate the machine.
    maxWorkers: 4,
  },
});
