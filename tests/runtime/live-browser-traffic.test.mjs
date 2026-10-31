// The live tests' browser marks its requests, so site analytics leave it out: every browser
// context the kit opens carries the mark, and the mark is the one the front Worker reads.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { OWN_TRAFFIC } from '../../tools/staging/client.mjs';

test('every live browser context sends the mark the front Worker looks for', async () => {
  const worker = await readFile('cloudflare/worker/site-events.ts', 'utf8');
  const [name] = Object.keys(OWN_TRAFFIC);
  assert.match(worker, new RegExp(`OWN_TRAFFIC_HEADER = '${name}'`));
  assert.equal(OWN_TRAFFIC[name], '1');
  let contexts = 0;
  for (const file of await readdir('tools/staging')) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(`tools/staging/${file}`, 'utf8');
    for (const [call] of source.matchAll(/\.newContext\([^)]*\)/g)) {
      contexts += 1;
      assert.match(call, /extraHTTPHeaders: OWN_TRAFFIC/, `${file}: ${call}`);
    }
  }
  assert.ok(contexts > 0, 'no browser context found: the pattern above went stale');
});
