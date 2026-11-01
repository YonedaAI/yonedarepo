// The logging rules a reviewer should not have to catch: one logger, and every queue message
// and Durable Object call able to carry the request id (docs/logging.md).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = 'cloudflare';
/** The logger writes the lines. Superfan's notices and its dead-man stay bare: what watches the
 * platform must not depend on the code it watches. */
const MAY_CALL_CONSOLE = new Set([
  'cloudflare/worker/log.ts',
  'cloudflare/superfan/notify.ts',
  'cloudflare/superfan/deadman.ts',
]);

async function sources(directory = ROOT) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

/** The text with comments gone, so prose about `console.log` does not count. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

test('nothing in cloudflare/ writes to the console except the logger', async () => {
  const files = await sources();
  assert.ok(files.length > 100, files.join());
  const offenders = [];
  for (const file of files) {
    if (MAY_CALL_CONSOLE.has(file)) continue;
    if (/\bconsole\s*(\.|\[)/.test(code(await readFile(file, 'utf8')))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'use log.info, log.warn or log.error from worker/log.ts');
});

test('the check refuses what it is there to refuse', () => {
  assert.ok(/\bconsole\s*(\.|\[)/.test(code("console.warn('x');")));
  assert.ok(/\bconsole\s*(\.|\[)/.test(code("console['log']('x');")));
  assert.ok(!/\bconsole\s*(\.|\[)/.test(code('// console.warn is for the logger\n')));
});

test('every platform queue send goes through carriedQueue, so a job keeps its request id', async () => {
  const offenders = [];
  for (const file of await sources(`${ROOT}/worker`)) {
    if (file.endsWith('request-scope.ts')) continue;
    const text = code(await readFile(file, 'utf8'));
    if (/(?<!carriedQueue\()env\.PLATFORM_QUEUE\.send(?:Batch)?\(|(?<!carriedQueue)\(env\.PLATFORM_CHECKS\s*\?\?\s*env\.PLATFORM_QUEUE\)\.send/.test(text))
      offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
