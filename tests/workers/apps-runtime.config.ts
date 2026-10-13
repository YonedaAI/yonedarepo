import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { bookingBundle } from './apps-booking-fixture.ts';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('../../cloudflare/apps/index.ts', import.meta.url)),
      miniflare: {
        compatibilityDate: '2026-10-12',
        workerLoaders: { LOADER: {} },
        durableObjects: { APP_RUNNERS: { className: 'AppRunner', useSQLite: true } },
        r2Buckets: ['OBJECTS'],
        bindings: { BOOKING_BUNDLE: bookingBundle() },
      },
    }),
  ],
  test: {
    include: [
      'tests/workers/apps-runtime.test.ts',
      'tests/workers/apps-host.test.ts',
      'tests/workers/apps-booking.test.ts',
    ],
    testTimeout: 20000,
  },
});
