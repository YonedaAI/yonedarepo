// The superfan Worker in workerd with a fake telemetry source and a fake model endpoint:
// no Cloudflare API token, provider key or paid call is involved.
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('../../cloudflare/superfan/index.ts', import.meta.url)),
      miniflare: {
        name: 'yoneda-superfan-test',
        compatibilityDate: '2026-10-07',
        durableObjects: { LEDGER: { className: 'SuperfanLedger', useSQLite: true } },
        bindings: {
          CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
          WATCH_SCRIPT: 'yonedarepo-platform-dev',
          WATCH_URL: 'https://yonedarepo-platform-dev.example.workers.dev',
          NS_SOURCE_REPOSITORY: '11111111111111111111111111111111',
          NS_OBJECT_PUSH_QUEUE: '22222222222222222222222222222222',
          NS_CHECK_CONTAINER: '33333333333333333333333333333333',
          QUEUE_JOBS_ID: '44444444444444444444444444444444',
          QUEUE_DEAD_LETTER_ID: '55555555555555555555555555555555',
          CHECK_CONTAINER_APP_ID: '66666666-6666-4666-8666-666666666666',
          TELEMETRY_SOURCE: 'cloudflare',
          SUPERFAN_MODEL: 'mimo-v2.6-flash',
          MIMO_TOKEN_PLAN_REGION: 'sgp',
          DAILY_CAP_MICROUSD: '1000000',
        },
      },
    }),
  ],
  // One workerd per worker: cap it so parallel builders don't saturate the machine.
  test: { include: ['tests/superfan/**/*.test.ts'], testTimeout: 20_000, maxWorkers: 4 },
});
