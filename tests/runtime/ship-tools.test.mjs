// The ship pipeline's scripts: what reaches a public log, what counts as a ship, what the
// monitor calls a failure. Each runs against fakes; nothing here reaches GitHub or prod.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { allPassed, minimal, newest, table } from '../../tools/ship/evidence.mjs';
import { findShip, shipPull, shipRun } from '../../tools/ship/find-ship.mjs';
import { fresh, plural, watch } from '../../tools/ship/monitor.mjs';
import { publicLine, runQuiet } from '../../tools/ship/quiet.mjs';
import { treeOf } from '../../tools/staging/client.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const PRIVATE = ['kitabc123', 'delivered+kitabc123@resend.dev', 'owner@example.com', 'r0123456789abcdef', 'tok_secret'];

test('deploy output: guards and timing rows pass, anything that can name an account does not', () => {
  for (const line of [
    'Refusing prod: dev yonedarepo-dev-platform runs abc, not HEAD def.',
    'Stopping before the container rollout: active instances (app: 2) would be killed.',
    'wrangler deploy --config cloudflare/x.jsonc failed (exit status: 1)',
  ])
    assert.equal(publicLine('deploy', line), `::error::${line}`);
  const row = '| deploy yonedarepo-prod-platform | 12.3 | ok |';
  assert.equal(publicLine('deploy', row), row);
  assert.equal(publicLine('deploy', '| secrets x | 1.0 | FAILED |'), '| secrets x | 1.0 | FAILED |');
  for (const line of [
    'Getting User settings...',
    'You are logged in with an API Token, associated with the email owner@example.com.',
    '| Account Name | Account ID |',
    '| owner GET /api/v1/repos (platform proxy) | FAIL | HTTP 500: {"account":"kitabc123"} |',
    '| frontend GET / | pass | https://yonedarepo.com/ serves HTML |',
    '$ wrangler deploy --config x',
    'Uploaded yonedarepo-prod-platform (12.3 sec)',
    'wrangler whoami owner@example.com',
  ])
    assert.equal(publicLine('deploy', line), null, line);
});

test('kit output: only status, item and time, never a reason or a table', () => {
  assert.equal(publicLine('kit', 'PASS 13 1234ms'), 'PASS 13 1234ms');
  assert.equal(publicLine('kit', 'FAIL 12 88ms (kit account kitabc123: repo r0123456789abcdef refused owner@example.com)'), 'FAIL 12 88ms');
  for (const line of ['… 12 CLI: device login', '| 12 | CLI | PASS | 1.0 s | account=kitabc123 |', 'Left repositories: kit-cli-1', 'Evidence: /home/runner/x.json'])
    assert.equal(publicLine('kit', line), null, line);
});

test('runQuiet keeps the exit code, closes the job summary and names no detail', async () => {
  const lines = [];
  process.env.GITHUB_STEP_SUMMARY = '/nonexistent/summary';
  const script = `console.log('PASS 0 1ms'); console.error('FAIL 1 2ms (${PRIVATE[1]})'); console.log(process.env.GITHUB_STEP_SUMMARY ?? 'FAIL closed 3ms'); process.exit(3)`;
  const code = await runQuiet('kit', process.execPath, ['-e', script], (l) => lines.push(l));
  delete process.env.GITHUB_STEP_SUMMARY;
  assert.equal(code, 3);
  const shown = lines.join('\n');
  assert.match(shown, /^PASS 0 1ms$/m);
  assert.match(shown, /^FAIL 1 2ms$/m);
  assert.match(shown, /^FAIL closed 3ms$/m);
  assert.match(shown, /kit exited 3/);
  for (const secret of PRIVATE) assert.ok(!shown.includes(secret));
});

const kit = (status = 'pass') => ({
  schema: 1,
  origin: 'https://dev.yonedarepo.com',
  platform: 'https://yonedarepo-dev-platform.mlong-f01.workers.dev',
  tree: TREE,
  recorded_at: '2026-10-31T00:00:00.000Z',
  items: [
    { id: '0', title: 'Live revisions (/health)', status: 'pass', ms: 5, metrics: { front: SHA, platform: SHA, account: PRIVATE[0] } },
    { id: '12', title: 'CLI', status, ms: 1500, reason: `kit ${PRIVATE[1]}`, metrics: { repo: PRIVATE[3], owner: PRIVATE[2] } },
  ],
});

test('minimal evidence holds only allowed fields, and what the prod guard reads', () => {
  const out = minimal(kit());
  const text = JSON.stringify(out);
  for (const value of [...PRIVATE, 'origin', 'mlong-f01', 'reason']) assert.ok(!text.includes(value), value);
  assert.deepEqual(Object.keys(out), ['schema', 'tree', 'recorded_at', 'items']);
  assert.deepEqual(out.items[0], { id: '0', title: 'Live revisions (/health)', status: 'pass', ms: 5, metrics: { front: SHA, platform: SHA } });
  assert.deepEqual(out.items[1].metrics, {});
  assert.throws(() => minimal({ ...kit(), tree: null }), /no tree/);
  const noRevision = kit();
  noRevision.items[0].metrics.front = 'kitabc123';
  assert.throws(() => minimal(noRevision), /front revision/);
});

test('allPassed refuses a skip as the prod guard does, and the table names no detail', () => {
  assert.ok(allPassed(kit()));
  assert.ok(!allPassed(kit('skip')));
  assert.ok(!allPassed(kit('fail')));
  assert.ok(!allPassed({ items: [] }));
  const shown = table(kit('fail'));
  assert.match(shown, /1 of 2 passed/);
  for (const secret of PRIVATE) assert.ok(!shown.includes(secret));
});

test('newest picks the latest evidence of its prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-evidence-'));
  try {
    writeFileSync(join(dir, 'realworld-1.json'), '{"n":1}');
    writeFileSync(join(dir, 'realworld-2.json'), '{"n":2}');
    writeFileSync(join(dir, 'prod-smoke-3.json'), '{"n":3}');
    utimesSync(join(dir, 'realworld-1.json'), new Date(), new Date(Date.now() + 5000));
    assert.equal(newest(dir, 'realworld').n, 1);
    assert.throws(() => newest(dir, 'browser-gate'), /No browser-gate/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('treeOf reads a commit in the checkout and gives null for anything else', () => {
  const root = resolve(import.meta.dirname, '../..');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(treeOf(root, head), tree);
  assert.equal(treeOf(root, '0'.repeat(40)), null);
  assert.equal(treeOf(root, undefined), null);
  assert.equal(treeOf(root, '--all'), null);
});

const REPO = 'YonedaAI/yonedarepo';
const MERGE = 'c'.repeat(40);
const pull = (over = {}) => ({
  merged_at: '2026-10-31T00:00:00Z',
  merge_commit_sha: MERGE,
  base: { ref: 'main' },
  head: { ref: 'dev', sha: SHA, repo: { full_name: REPO } },
  ...over,
});
const run = (over = {}) => ({
  id: 7,
  run_number: 7,
  event: 'pull_request',
  conclusion: 'success',
  head_sha: SHA,
  head_branch: 'dev',
  head_repository: { full_name: REPO },
  path: '.github/workflows/ship.yml',
  ...over,
});

test('a ship PR is merged, from this repository, from dev, into main, and made this commit', () => {
  const where = { repo: REPO, sha: MERGE };
  assert.ok(shipPull([pull()], where));
  for (const other of [
    pull({ merged_at: null }),
    pull({ merge_commit_sha: SHA }),
    pull({ base: { ref: 'release' } }),
    pull({ head: { ref: 'hotfix', sha: SHA, repo: { full_name: REPO } } }),
    pull({ head: { ref: 'dev', sha: SHA, repo: { full_name: 'someone/yonedarepo' } } }),
    pull({ head: { ref: 'dev', sha: SHA, repo: null } }),
  ])
    assert.equal(shipPull([other], where), undefined);
});

test('evidence counts only from a successful Ship run of this repository', () => {
  const where = { repo: REPO, head: SHA };
  assert.equal(shipRun([run(), run({ id: 8, run_number: 8 })], where).id, 8);
  for (const forged of [
    run({ head_repository: { full_name: 'someone/yonedarepo' } }),
    run({ head_branch: 'patch-1' }),
    run({ path: '.github/workflows/evil.yml' }),
    run({ conclusion: 'failure' }),
    run({ event: 'workflow_dispatch' }),
    run({ head_sha: MERGE }),
  ])
    assert.equal(shipRun([forged], where), undefined);
});

function github({ pulls = [pull()], runs = [run()], status = 200 }) {
  return async (url) => {
    const body = url.includes('/commits/') ? pulls : { workflow_runs: runs };
    return { ok: status === 200, status, json: async () => body };
  };
}
const find = (fake) => findShip({ fetch: github(fake), sleep: async () => {}, token: 't', repo: REPO, sha: MERGE });

test('findShip: a ship, not a ship, and a merged ship nothing tested', async () => {
  assert.deepEqual(await find({}), { ship: true, pr_head: SHA, run_id: 7 });
  assert.deepEqual(await find({ pulls: [] }), { ship: false });
  await assert.rejects(find({ runs: [] }), /No successful Ship run/);
  await assert.rejects(find({ status: 403 }), /GitHub answered 403/);
});

const HOUR = '2026-10-31T10:00:00.000Z';
const since = Date.parse('2026-10-31T11:00:00.000Z');
const finding = (id, first_seen = HOUR) => ({ id, first_seen, component: 'api_worker', summary: `private ${PRIVATE[1]}` });

test('a finding is new when it was not open before, or was first seen since the deploy began', () => {
  const known = new Set([1, 3]);
  const open = [finding(1), finding(2), finding(3, '2026-10-31T11:00:01.000Z')];
  assert.deepEqual(
    fresh(open, known, since).map((f) => f.id),
    [2, 3],
  );
  assert.equal(plural(1), '1 new finding');
  assert.equal(plural(2), '2 new findings');
});

/** Fake prod: `script[poll]` overrides the health, run and findings of that poll. */
function prod(script = []) {
  const calls = { run: 0 };
  const fetch = async (url, init) => {
    const at = script[calls.run] ?? {};
    if (url.endsWith('/run')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer read');
      calls.run++;
      if (at.run === null) throw new Error('private network detail');
      return { ok: true, json: async () => at.run ?? { outcome: 'ok' } };
    }
    if (url.includes('/findings')) {
      const list = calls.run ? (script[calls.run - 1] ?? {}).findings : undefined;
      if (list === null) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ findings: list ?? [finding(1)] }) };
    }
    return { ok: true, json: async () => ({ revision: at.revision ?? SHA }) };
  };
  return { calls, fetch };
}
const monitor = ({ fetch }, polls = 7) => {
  const log = [];
  return watch({ fetch, wait: async () => {}, log: (l) => log.push(l), token: 'read', superfan: 'https://s', health: ['https://a/health', 'https://b/health'], revision: SHA, since, polls, intervalMs: 1 }).then((result) => ({ ...result, log }));
};

test('the monitor runs every poll and passes while prod is quiet', async () => {
  const fake = prod();
  const { ok, line, log } = await monitor(fake);
  assert.ok(ok, line);
  assert.equal(fake.calls.run, 7);
  assert.equal(log.length, 7);
  assert.match(line, /7 polls: healthy, 0 new findings/);
});

test('a new finding fails at once with only a count', async () => {
  const fake = prod([{}, { findings: [finding(1), finding(2), finding(5)] }]);
  const { ok, line, log } = await monitor(fake);
  assert.ok(!ok);
  assert.equal(line, '2 new findings');
  assert.equal(fake.calls.run, 2);
  const shown = [line, ...log].join('\n');
  for (const secret of [...PRIVATE, 'private', 'api_worker']) assert.ok(!shown.includes(secret));
});

test('one blip passes; two in a row fail on health or on Superfan', async () => {
  assert.ok((await monitor(prod([{ revision: 'old' }, {}, { run: null }]))).ok);
  const health = await monitor(prod([{ revision: 'old' }, { revision: 'old' }]));
  assert.deepEqual([health.ok, health.line], [false, `2 of 2 /health not at ${SHA.slice(0, 12)}.`]);
  const superfan = await monitor(prod([{ run: null }, { run: null }]));
  assert.deepEqual([superfan.ok, superfan.line], [false, 'The monitor could not read Superfan.']);
  assert.ok(!superfan.log.join('\n').includes('private network detail'));
});

test('a watch that never saw telemetry is not a quiet one, and busy is not a miss', async () => {
  const blind = await monitor(prod(Array(7).fill({ run: { outcome: 'telemetry_failed' } })));
  assert.deepEqual([blind.ok, blind.line], [false, 'Superfan had no telemetry on any poll.']);
  const busy = await monitor(prod([{ run: { outcome: 'busy' } }, { run: { outcome: 'busy' } }]));
  assert.ok(busy.ok, busy.line);
});

test('a monitor that cannot take its starting list fails', async () => {
  const fetch = async () => ({ ok: false, status: 401 });
  const { ok, line } = await monitor({ fetch });
  assert.deepEqual([ok, line], [false, 'The monitor could not read Superfan.']);
});
