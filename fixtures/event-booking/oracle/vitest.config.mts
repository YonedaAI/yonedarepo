// Explicit ESM even when the immutable bundle has no ancestor package.json.
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {cloudflareTest} from '@cloudflare/vitest-plugin';
import {defineConfig} from 'vitest/config';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const subject = resolve(process.env.YONEDA_BOOKING_SUBJECT ?? resolve(root, 'fixtures/event-booking/source'));
export default defineConfig({
  root,
  // Keep optimization cache outside both immutable tests and root-owned packages.
  cacheDir:mkdtempSync(resolve(tmpdir(),'yoneda-booking-vite-')),
  resolve:{alias:{'booking-subject':resolve(subject,'dist/worker.js')}},
  plugins:[cloudflareTest({main:fileURLToPath(new URL('./entrypoint.ts',import.meta.url)),
    miniflare:{name:'booking-protected-test',compatibilityDate:'2026-10-07',
      durableObjects:{BOOKINGS:{className:'FixtureApp',useSQLite:true}},
      bindings:{BOOKING_STAGE:process.env.YONEDA_BOOKING_STAGE ?? 'duplicate_registration_bugfix'}}})],
  test:{include:['fixtures/event-booking/oracle/acceptance.test.ts'],testTimeout:10000},
});
