// The managed agents Worker in workerd with a fake platform API and a fake AI Gateway: no
// provider key, gateway or paid model call is involved.
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('../../cloudflare/managed/index.ts', import.meta.url)),
      miniflare: {
        name: 'yoneda-managed-test',
        compatibilityDate: '2026-10-07',
        durableObjects: {
          REPOS: { className: 'RepoAgents', useSQLite: true },
          LEDGER: { className: 'CreditLedger', useSQLite: true },
        },
        workflows: {
          REVIEWS: { name: 'yoneda-managed-reviews-test', className: 'ManagedReviewWorkflow' },
        },
        queueProducers: { RUNS: { queueName: 'yoneda-managed-runs-test' } },
        bindings: {
          PUBLIC_URL: 'https://managed.example.com',
          AI_GATEWAY_URL: 'https://gateway.example.com/v1/acct/yonedarepo-test-agents',
          AI_GATEWAY_PROVIDERS: 'claude=anthropic,zai=custom-zai,mimo=custom-mimo',
          CODE_REVIEW_MODEL: 'zai/glm-5.3-flash',
          SECURITY_REVIEW_MODEL: 'claude/claude-sonnet-5-5',
          MANAGED_ADMIN_TOKEN: 'fixture-admin-token',
        },
      },
    }),
  ],
  // One workerd per worker: cap it so parallel builders don't saturate the machine.
  test: { include: ['tests/managed/**/*.test.ts'], testTimeout: 20_000, maxWorkers: 2 },
});
