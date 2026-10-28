// Item 27 of the staging kit (L1 of the agent e2e strategy, no model): the Git semantics an
// agent client relies on, scripted with stock git, the `yoneda` CLI and the repository MCP on
// one fresh repository. Smart HTTP clones over protocol v2 (full, partial with lazy blobs,
// shallow then deepened); two yoneda:: clones branch, commit, push, fetch and pull, rebase
// locally (and force-push the feature branch, never main), merge, cherry-pick, revert, push an annotated
// tag, hit a same-line conflict that is refused naming the file and then resolved, and open
// and land a change with the CLI; the MCP reads main's log, the session listing and the agent
// context; a small Git LFS file round-trips (lfs-flow.mjs at 1 MiB, when git-lfs is
// installed). The rest is covered by the items `--git-semantics` runs with this one:
// concurrent pushes (13), change review by a second account (18), server-side rebase (21),
// releases (23) and SSH (26, with --ssh). The repositories are deleted.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitLfsVersion, lfsFlow } from './lfs-flow.mjs';
import { McpClient } from './mcp-client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');
const NOTES = 'one\ntwo\nthree\nfour\nfive\n';

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Git over smart HTTP with the kit's PAT as a header (environment only, never an argument). */
function smartHttp(kit) {
  return kit.env({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${kit.api}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${kit.token}`,
  });
}

/** Runs `steps` in order, timing each into `metrics.steps`; the first failure names its step. */
async function steps(metrics, list) {
  metrics.steps = {};
  for (const [name, run] of list) {
    const started = performance.now();
    try {
      await run();
    } catch (e) {
      throw new Error(`${name}: ${e.message}`);
    }
    metrics.steps[name] = Math.round(performance.now() - started);
  }
  metrics.steps_passed = list.length;
}

/** 27: every Git semantic above on a fresh repository; `platform` is the account session. */
export async function gitSemantics(kit, { platform, lfs = true }, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const api = kit.pat();
  const name = `kit-git-${Date.now()}`;
  const files = [
    { path: 'README.md', content_b64: b64('# git semantics kit\n') },
    { path: 'notes.txt', content_b64: b64(NOTES) },
  ];
  const repo = (await api.post('/repos', { name, policy: { approvals: 0, required_checks: [] }, files, author })).id;
  kit.repos.push({ id: repo, name });
  metrics.repo = repo;
  const main = async () => (await api.get(`/repos/${repo}/refs`)).refs['refs/heads/main'];
  const http = smartHttp(kit);
  const smart = `${kit.api}/git/${repo}.git`;
  const [a, b] = [kit.path('git-a'), kit.path('git-b')];
  const git = (dir, ...args) => kit.gitOk(dir, ...args);
  const commit = async (dir, path, text, message) => {
    write(dir, path, text);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  /** Pushes and requires main (or `ref`) on the platform to be what the clone has. */
  const pushed = async (dir, ref = 'main', ...args) => {
    await kit.ok('git', ['push', '-q', 'origin', ...args, ref], { cwd: dir });
    const local = await git(dir, 'rev-parse', ref);
    const remote = (await api.get(`/repos/${repo}/refs`)).refs[`refs/heads/${ref}`];
    assert.equal(remote, local, `${ref} on the platform is not the pushed commit`);
    return local;
  };
  const mcp = new McpClient(`${kit.api}/api/v1/repos/${repo}/mcp`, kit.token);

  await steps(metrics, [
    ['clone yoneda::', async () => {
      await kit.ok('git', ['clone', '-q', kit.remote(repo), a]);
      await kit.ok('git', ['clone', '-q', kit.remote(repo), b]);
    }],
    ['commit and push', () => commit(a, 'src/one.txt', '1\n', 'Kit: one').then(() => pushed(a))],
    ['clone v2 (smart HTTP)', async () => {
      const done = await kit.run('git', ['-c', 'protocol.version=2', 'clone', '-q', smart, kit.path('v2')], { env: { ...http, GIT_TRACE_PACKET: '1' } });
      assert.equal(done.code, 0, done.stderr.slice(-400));
      assert.match(done.stderr, /git< version 2/, 'the server did not answer with protocol v2');
      await git(kit.path('v2'), 'fsck', '--strict');
    }],
    ['clone partial (blob:none, lazy blobs)', async () => {
      const dir = kit.path('partial');
      const done = await kit.run('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', smart, dir], { env: http });
      assert.equal(done.code, 0, done.stderr.slice(-400));
      const missing = (await kit.run('git', ['rev-list', '--objects', '--missing=print', 'HEAD'], { cwd: dir, env: http })).stdout.split('\n').filter((l) => l.startsWith('?'));
      assert.ok(missing.length > 0, 'a blob:none clone holds every blob already');
      const checkout = await kit.run('git', ['checkout', '-q', 'main'], { cwd: dir, env: http });
      assert.equal(checkout.code, 0, checkout.stderr.slice(-400));
      assert.equal(readFileSync(join(dir, 'src/one.txt'), 'utf8'), '1\n', 'the lazy blob is the pushed content');
    }],
    ['clone shallow (depth 1, deepen)', async () => {
      const dir = kit.path('shallow');
      assert.equal((await kit.run('git', ['clone', '-q', '--depth', '1', smart, dir], { env: http })).code, 0);
      assert.equal(await git(dir, 'rev-list', '--count', 'HEAD'), '1');
      assert.equal((await kit.run('git', ['fetch', '-q', '--deepen', '1'], { cwd: dir, env: http })).code, 0);
      assert.equal(await git(dir, 'rev-list', '--count', 'HEAD'), '2');
    }],
    ['branch push', async () => {
      await git(a, 'switch', '-q', '-c', 'kit-feat');
      await commit(a, 'feat.txt', 'feature\n', 'Kit: feature');
      await pushed(a, 'kit-feat', '-u');
    }],
    ['fetch and pull', async () => {
      await git(b, 'fetch', '-q', 'origin');
      assert.equal(await git(b, 'rev-parse', 'origin/kit-feat'), await git(a, 'rev-parse', 'kit-feat'));
      await git(b, 'pull', '-q', '--ff-only', 'origin', 'main');
      assert.equal(await git(b, 'rev-parse', 'HEAD'), await main());
    }],
    ['merge --no-ff and push', async () => {
      await git(b, 'merge', '-q', '--no-ff', '-m', 'Kit: merge kit-feat', 'origin/kit-feat');
      const merge = await pushed(b);
      assert.equal((await git(b, 'rev-list', '--parents', '-n', '1', merge)).split(' ').length, 3, 'not a merge commit');
    }],
    ['local rebase and force-push a branch', async () => {
      await git(a, 'switch', '-q', '-c', 'kit-topic', 'origin/main~1');
      await commit(a, 'topic.txt', 'topic\n', 'Kit: topic');
      await pushed(a, 'kit-topic', '-u');
      await git(a, 'fetch', '-q', 'origin');
      await git(a, 'rebase', '-q', 'origin/main');
      await pushed(a, 'kit-topic', '--force');
      await git(a, 'merge-base', '--is-ancestor', 'origin/main', 'kit-topic');
      const refused = await kit.git(a, 'push', 'origin', '+kit-topic:main');
      assert.notEqual(refused.code, 0, 'main was force-pushed');
    }],
    ['cherry-pick and push', async () => {
      await git(b, 'pull', '-q', '--ff-only', 'origin', 'main');
      await git(b, 'cherry-pick', await git(a, 'rev-parse', 'kit-topic'));
      await pushed(b);
      assert.equal(readFileSync(join(b, 'topic.txt'), 'utf8'), 'topic\n');
    }],
    ['revert and push', async () => {
      await git(b, 'revert', '--no-edit', 'HEAD');
      await pushed(b);
      const served = await kit.run('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: b });
      assert.equal(served.stdout.split(/\s/)[0], await git(b, 'rev-parse', 'HEAD'));
    }],
    ['annotated tag', async () => {
      await git(b, 'tag', '-a', 'v0.1.0', '-m', 'Kit release');
      await kit.ok('git', ['push', '-q', 'origin', 'v0.1.0'], { cwd: b });
      const dir = kit.path('tagged');
      assert.equal((await kit.run('git', ['clone', '-q', smart, dir], { env: http })).code, 0);
      assert.equal(await git(dir, 'cat-file', '-t', 'v0.1.0'), 'tag');
    }],
    ['conflict refused, then resolved', async () => {
      await git(a, 'switch', '-q', 'main');
      await git(a, 'pull', '-q', '--ff-only', 'origin', 'main');
      await git(b, 'pull', '-q', '--ff-only', 'origin', 'main');
      await commit(a, 'notes.txt', NOTES.replace('three', 'three (a)'), 'Kit: a edits three');
      await commit(b, 'notes.txt', NOTES.replace('three', 'three (b)'), 'Kit: b edits three');
      await pushed(a);
      const lost = await kit.git(b, 'push', 'origin', 'main');
      assert.notEqual(lost.code, 0, 'the second same-line push landed');
      assert.match(lost.stderr, /notes\.txt/, `the refusal does not name notes.txt: ${lost.stderr.slice(-300)}`);
      const rebase = await kit.git(b, 'pull', '--rebase', 'origin', 'main');
      assert.notEqual(rebase.code, 0, 'the rebase did not stop at the conflict');
      write(b, 'notes.txt', NOTES.replace('three', 'three (a) (b)'));
      await git(b, 'add', 'notes.txt');
      await kit.ok('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: b });
      await pushed(b);
      assert.equal(await git(b, 'rev-list', '--merges', '--count', 'HEAD~1..HEAD'), '0', 'the resolution is linear');
    }],
    ['change create and land (CLI)', async () => {
      await git(a, 'pull', '-q', '--ff-only', 'origin', 'main');
      await git(a, 'switch', '-q', '-c', 'kit-change');
      const head = await commit(a, 'change.txt', 'change\n', 'Kit: change');
      await pushed(a, 'kit-change', '-u');
      const opened = await kit.yonedaOk(['change', 'create', '--title', 'Kit change'], { cwd: a });
      const number = opened.stdout.match(/#(\d+)/)?.[1];
      assert.ok(number, `change create printed no number: ${opened.stdout}`);
      await kit.yonedaOk(['change', 'land', number], { cwd: a });
      const change = await api.get(`/repos/${repo}/changes/${number}`);
      assert.equal(change.status, 'landed');
      await git(b, 'pull', '-q', '--ff-only', 'origin', 'main');
      await git(b, 'merge-base', '--is-ancestor', head, 'HEAD');
    }],
    ['MCP reads', async () => {
      const log = await mcp.tool('git_log', { ref: 'main', limit: 5 });
      assert.equal(JSON.stringify(log).includes(await main()), true, 'git_log does not show main');
      const context = await mcp.tool('git_context', { branch: 'main', sessions: 3 });
      assert.equal(context.main, await main());
      assert.ok(Array.isArray((await mcp.tool('git_sessions_recent', { limit: 5 })).sessions));
    }],
    ['history fsck', async () => {
      const dir = kit.path('final');
      assert.equal((await kit.run('git', ['clone', '-q', smart, dir], { env: http })).code, 0);
      await git(dir, 'fsck', '--strict');
      assert.equal(await git(dir, 'rev-parse', 'HEAD'), await main());
    }],
  ]);

  if (lfs && platform) {
    try {
      gitLfsVersion();
      const lfsMetrics = {};
      await lfsFlow({ api: kit.api, platform, mb: 1 }, lfsMetrics);
      metrics.lfs = `ok ${lfsMetrics.push_ms} ms push`;
    } catch (e) {
      if (/git-lfs|git lfs/i.test(e.message) && !/push|clone|sha256/.test(e.message)) metrics.lfs = `skipped: ${e.message.slice(0, 120)}`;
      else throw new Error(`LFS small file: ${e.message}`);
    }
  }
  metrics.covered_elsewhere = '13 concurrency, 18 change review, 21 server rebase, 23 releases, 26 ssh (--ssh)';
}
