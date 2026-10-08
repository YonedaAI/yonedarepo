import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest({
    main: './tests/workers/entrypoint.ts',
    wrangler: {configPath:'./tests/workers/wrangler.jsonc'},
    miniflare: {
      name: 'yoneda-test', compatibilityDate: '2026-10-07', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { REPOSITORIES: { className: 'RepositoryAuthority', useSQLite: true }, LIVE: { className: 'LiveRoom', useSQLite: true } },
      r2Buckets: ['OBJECTS'], d1Databases: ['INDEX'],
      bindings: { OWNER_TOKEN: 'local-test-owner', ARTIFACTS_NAMESPACE: 'yoneda-test', CODEX_MODEL: 'gpt-5.6-luna', CLAUDE_MODEL: 'claude-sonnet-4-6' },
    },
  })],
  test: { include: ['tests/workers/**/*.test.ts'], testTimeout: 20_000 },
});
