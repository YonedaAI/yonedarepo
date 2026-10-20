#!/usr/bin/env node
// P5 / Scion S12 hosted tier measurement against a deployed platform Worker: hosted
// Container check runs cold (no seed) and warm (seed), and API object reads cold and warm.
// Reports reads served per tier (seed -> edge Cache API -> R2 -> object store) and the
// per-tier hit rate, served-at-tier / reached-tier, without adjusting the definition. An
// explicit, separate command: it creates a repository, commits and Container check runs.
// Credentials come from YONEDA_USERNAME / YONEDA_PASSWORD. Evidence goes to
// .local/platform-live/tiers.json.
// Usage: node tools/platform-tiers.mjs --url https://<deployment> [--files 120]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, files: { type: 'string', default: '120' } } });
assert.ok(values.url, 'Pass --url of the deployed platform');
const url = values.url.replace(/\/$/, '');
const FILES = Number(values.files);
const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
});
assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
async function call(path, body) {
  const response = await fetch(`${url}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${path}: ${value.error?.code} ${value.error?.message}`);
  return value;
}
const file = (path, text) => ({ path, content_b64: Buffer.from(text).toString('base64') });
const author = { name: 'Tier bench', email: 'tiers@yonedarepo.invalid' };

/** served-at-tier / reached-tier for each tier, null when nothing reached it. */
function rates(t) {
  const reachedR2 = t.r2 + t.store;
  const reachedEdge = t.edge + reachedR2;
  return {
    edge: reachedEdge ? t.edge / reachedEdge : null,
    r2: reachedR2 ? t.r2 / reachedR2 : null,
    ...(t.files !== undefined ? { seed: t.files ? t.seed / t.files : null } : {}),
  };
}

const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['sh', '-c', 'test -f a.txt'], timeout_seconds: 60 } } };
const files = [file('a.txt', 'good\n'), ...Array.from({ length: FILES }, (_, i) => file(`src/${i}.txt`, `file ${i}\n`))];
const created = await call('/repos', { name: `tiers-${Date.now()}`, policy, files, author });
const repo = `/repos/${created.id}`;

/** Commits one change, waits for its hosted Container check run, returns evidence tiers. */
async function checked(path, text) {
  const made = await call(`${repo}/commits`, { ref: 'main', changes: [file(path, text)], message: `tiers ${path}`, author });
  for (let waited = 0; ; waited += 3000) {
    assert.ok(waited < 300_000, `check run for ${made.commit} did not finish`);
    const detail = await call(`${repo}/commits/${made.commit}`);
    const check = detail.checks.find((c) => c.name === 'unit');
    if (check) {
      const evidence = JSON.parse(check.evidence);
      assert.ok(evidence.tiers, `check evidence has no tiers: ${check.evidence.slice(0, 300)}`);
      return { commit: made.commit, status: check.status, duration_ms: evidence.duration_ms, seed: evidence.seed ?? null, tiers: evidence.tiers };
    }
    const errored = detail.check_runs.find((r) => r.status === 'errored');
    assert.ok(!errored, `check run errored: ${errored?.result}`);
    await sleep(3000);
  }
}

const cold = await checked('src/1.txt', 'cold edit\n');
await call(`${repo}/land`, { ref: 'main', commit: cold.commit });
await sleep(20_000); // the derive job writes the branch's warm-start seed after landing
const warm = await checked('src/2.txt', 'warm edit\n');

async function readAll(objects) {
  const tiers = { edge: 0, r2: 0, store: 0 };
  let after = null;
  do {
    const page = await call(`${repo}/objects`, { objects, after });
    for (const tier of Object.keys(tiers)) tiers[tier] += page.tiers[tier];
    after = page.next;
  } while (after !== null);
  return tiers;
}
const tree = await call(`${repo}/tree?path=src`);
const blobs = tree.entries.filter((e) => e.type === 'blob').map((e) => ({ id: e.id, kind: 'blob' }));
const firstRead = await readAll(blobs);
const secondRead = await readAll(blobs);
const changelog = await call(`${repo}/changelog`).catch((e) => ({ error: String(e.message) }));

const result = {
  repo: created.id,
  files: FILES + 1,
  check_runs: {
    cold: { ...cold, hit_rates: rates(cold.tiers) },
    warm: { ...warm, hit_rates: rates(warm.tiers) },
  },
  api_reads: {
    first: { tiers: firstRead, hit_rates: rates(firstRead) },
    second: { tiers: secondRead, hit_rates: rates(secondRead) },
  },
  changelog,
};
const evidence = {
  schema: 1,
  target: url,
  recorded_at: new Date().toISOString(),
  note: 'Hosted run from one client machine. Check runs read objects in the queue consumer; API reads run in the client-facing colo. Imports write objects through both cache tiers, so "first" API reads are not origin-cold.',
  result,
};
await mkdir(resolve(root, '.local/platform-live'), { recursive: true });
await writeFile(resolve(root, '.local/platform-live/tiers.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
