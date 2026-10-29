// The managed agents Worker in workerd with a fake platform API, a harness container double and
// a fake AI Gateway: no provider key, container, gateway or paid model call is involved.
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
          WORKSPACES: { className: 'WorkspaceAgents', useSQLite: true },
        },
        workflows: {
          REVIEWS: { name: 'yoneda-managed-reviews-test', className: 'ManagedReviewWorkflow' },
        },
        queueProducers: { RUNS: { queueName: 'yoneda-managed-runs-test' } },
        bindings: {
          PUBLIC_URL: 'https://managed.example.com',
          AI_GATEWAY_URL: 'https://gateway.example.com/v1/acct/yonedarepo-test-agents',
          AI_GATEWAY_PROVIDERS: 'claude=anthropic,codex=openai,zai=custom-zai,mimo=custom-mimo',
          MANAGED_ADMIN_TOKEN: 'fixture-admin-token',
          // A fixture vault key (not a secret): 32 bytes of 0x11.
          MANAGED_VAULT_KEY: '11'.repeat(32),
        },
      },
    }),
  ],
  // One workerd per worker: cap it so parallel builders don't saturate the machine.
  test: { include: ['tests/managed/**/*.test.ts'], testTimeout: 20_000, maxWorkers: 2 },
});
