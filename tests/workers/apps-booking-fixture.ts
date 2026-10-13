//! Test-only fixture build in a disposable directory; never writes another agent's files.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppBundle } from '../../cloudflare/apps/contracts.ts';
export function bookingBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'yoneda-apps-booking-'));
  try {
    cpSync(fileURLToPath(new URL('../../fixtures/event-booking/source/', import.meta.url)), root, {
      recursive: true,
    });
    const build = spawnSync(process.execPath, ['build.mjs'], {
      cwd: root,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (build.status !== 0) throw new Error(`Fixture build failed: ${build.stderr}`);
    const modules: Record<string, string> = {};
    for (const path of readdirSync(join(root, 'dist')).sort())
      modules[path] = readFileSync(join(root, 'dist', path), 'utf8');
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../fixtures/event-booking/app-profile.json', import.meta.url)),
        'utf8',
      ),
    );
    const bundle: AppBundle = {
      version: 1,
      revision: 'a'.repeat(40),
      policy_digest: 'c'.repeat(64),
      manifest,
      modules,
    };
    return JSON.stringify(bundle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
