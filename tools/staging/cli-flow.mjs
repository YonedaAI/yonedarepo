// CLI items of the staging kit: the git platform used without the agents website, through
// `yoneda` and `git-remote-yoneda` only. Item 12 signs in by device login and round-trips a
// repository through plain git; 13 pushes concurrently from two clones (server merge, then a
// same-line conflict resolved by pull); 14 checks that an atomic push with a stale branch and
// a push killed before its final compare-and-swap leave every ref and the log version as
// they were.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { casKillingProxy, deviceLogin, groupAlive } from './cli-tools.mjs';

const MAIN = 'refs/heads/main';

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** The platform's refs and log version, read with the PAT. */
async function refsOf(kit, repo) {
  return kit.pat().get(`/repos/${repo}/refs`);
}

async function commitAll(kit, dir, message) {
  await kit.gitOk(dir, 'add', '-A');
  await kit.gitOk(dir, 'commit', '-q', '-m', message);
  return kit.gitOk(dir, 'rev-parse', 'HEAD');
}

async function clone(kit, repo, name) {
  const dir = kit.path(name);
  const done = await kit.ok('git', ['clone', '-q', kit.remote(repo), dir]);
  return { dir, ms: done.ms };
}

/** 12: device login → PAT, `yoneda repo create`, clone, push 3 files, exact ids, fresh clone. */
export async function cliLoginRepo(kit, state, metrics) {
  await deviceLogin(kit, metrics);
  const name = `kit-cli-${Date.now()}`;
  const created = await kit.yonedaOk(['repo', 'create', name]);
  let repo = created.stdout.match(/\((r[0-9a-f]{20})\)/)?.[1];
  assert.ok(repo, `repo create printed no id: ${created.stdout}`);
  kit.repos.push({ id: repo, name });
  Object.assign(metrics, { repo, repo_name: name, create_ms: created.ms });
  const status = await kit.pat().get(`/repos/${repo}`);
  assert.deepEqual(status.policy, { approvals: 0, required_checks: [] }, `Unexpected policy ${JSON.stringify(status.policy)}`);
  const marker = `marker-${Date.now()}`;
  let first = await clone(kit, repo, 'c1');
  metrics.clone_ms = first.ms;
  let local = await threeFiles(kit, first.dir, marker);
  let pushed = await kit.git(first.dir, 'push', 'origin', 'main');
  // The documented flow (create, clone, commit, push) on a repository with no commits yet.
  // If the platform or the helper refuses it, item 12 fails with that error; the remaining
  // checks continue on a repository seeded through the account API, so items 13-16 still run.
  const problems = [];
  if (pushed.code !== 0) {
    const bug = `First push to the empty repository from \`yoneda repo create\` refused: ${pushed.stderr.split('\n').find((l) => l.includes('rejected')) ?? pushed.stderr.slice(-300)}`;
    metrics.empty_repo_push = bug;
    problems.push(bug);
    const seeded = await kit.pat().post('/repos', { name: `${name}-seeded`, policy: { approvals: 0, required_checks: [] }, files: [{ path: 'SEED.md', content_b64: Buffer.from('seed\n').toString('base64') }], author: { name: 'Staging kit', email: 'kit@yonedarepo.invalid' } });
    kit.repos.push({ id: seeded.id, name: `${name}-seeded` });
    metrics.seeded_repo = seeded.id;
    first = await clone(kit, seeded.id, 'c1-seeded');
    local = await threeFiles(kit, first.dir, marker);
    pushed = await kit.ok('git', ['push', 'origin', 'main'], { cwd: first.dir });
    repo = seeded.id;
  }
  metrics.push_ms = pushed.ms;
  metrics.push_said = pushed.stderr.split('\n').filter((l) => l.startsWith('yoneda:') || l.includes('landed')).join(' | ');
  const refs = await refsOf(kit, repo);
  Object.assign(metrics, { version: refs.version, head: refs.refs[MAIN], pushed: local });
  if (refs.refs[MAIN] !== local) {
    // Recorded, then the documented recovery (git pull fast-forwards) so later items run.
    problems.push(`GET refs main ${refs.refs[MAIN]} != pushed local HEAD ${local} (${metrics.push_said})`);
    await kit.gitOk(first.dir, 'pull', '-q', '--ff-only', 'origin', 'main');
    local = await kit.gitOk(first.dir, 'rev-parse', 'HEAD');
    assert.equal(local, refs.refs[MAIN], 'git pull did not fast-forward to main');
  }
  const second = await clone(kit, repo, 'c2');
  metrics.second_clone_ms = second.ms;
  const [head2, tree1, tree2] = [
    await kit.gitOk(second.dir, 'rev-parse', 'HEAD'),
    await kit.gitOk(first.dir, 'rev-parse', 'HEAD^{tree}'),
    await kit.gitOk(second.dir, 'rev-parse', 'HEAD^{tree}'),
  ];
  assert.equal(head2, local, 'The second clone has another HEAD');
  assert.equal(tree2, tree1, 'The second clone has another tree');
  await kit.gitOk(first.dir, 'fsck', '--strict');
  await kit.gitOk(second.dir, 'fsck', '--strict');
  metrics.fsck = 'ok';
  Object.assign(state, { repo, c1: first.dir, c2: second.dir, marker, v12: refs.version, commit12: local });
  if (problems.length) {
    metrics.problems = problems; // in full: the table's reason is cut at 400 characters
    throw new Error(problems.join('; '));
  }
}

/** The three files item 12 pushes, committed in `dir`; returns the commit id. */
function threeFiles(kit, dir, marker) {
  write(dir, 'README.md', `${marker} line one\nline two\nline three\n`);
  write(dir, 'src/lib.rs', 'pub fn kit() -> u32 {\n    12\n}\n');
  write(dir, 'docs/notes.md', '# Notes\n\nPushed with git-remote-yoneda.\n');
  return commitAll(kit, dir, 'Kit: three files');
}

/** 13: disjoint concurrent pushes both land; a same-line conflict is named, pulled, resolved. */
export async function cliConcurrency(kit, state, metrics) {
  if (!state.repo) return { skip: 'No CLI repository (item 12)' };
  const { repo, c1, c2 } = state;
  write(c1, 'one/a.txt', 'from clone one\n');
  write(c2, 'two/b.txt', 'from clone two\n');
  await commitAll(kit, c1, 'Kit: clone one');
  await commitAll(kit, c2, 'Kit: clone two');
  const started = performance.now();
  const [p1, p2] = await Promise.all([kit.git(c1, 'push', 'origin', 'main'), kit.git(c2, 'push', 'origin', 'main')]);
  metrics.disjoint_wall_ms = Math.round(performance.now() - started);
  Object.assign(metrics, { disjoint_push_ms: [p1.ms, p2.ms].join('/') });
  assert.ok(p1.code === 0 && p2.code === 0, `Disjoint pushes: ${p1.code}/${p2.code}: ${p1.stderr.slice(-300)} ${p2.stderr.slice(-300)}`);
  const merged = [p1, p2].filter((p) => /server merged concurrent changes/.test(p.stderr)).length;
  metrics.server_merges = merged;
  assert.ok(merged >= 1, `Neither push reported a server merge: ${p1.stderr.slice(-200)} | ${p2.stderr.slice(-200)}`);
  for (const dir of [c1, c2]) await kit.gitOk(dir, 'pull', '-q', '--ff-only', 'origin', 'main');
  const after = await refsOf(kit, repo);
  for (const dir of [c1, c2]) {
    assert.equal(await kit.gitOk(dir, 'rev-parse', 'HEAD'), after.refs[MAIN], 'A pull did not reach main');
    for (const path of ['one/a.txt', 'two/b.txt']) readFileSync(join(dir, path));
  }
  // Same line from both clones: the second push is refused naming the file.
  const readme = (who) => readFileSync(join(c1, 'README.md'), 'utf8').replace(/^.*\n/, `${who} line one\n`);
  write(c1, 'README.md', readme('clone-one'));
  write(c2, 'README.md', readme('clone-two'));
  await commitAll(kit, c1, 'Kit: clone one edits line one');
  await commitAll(kit, c2, 'Kit: clone two edits line one');
  const won = await kit.git(c1, 'push', 'origin', 'main');
  assert.equal(won.code, 0, `First same-line push failed: ${won.stderr.slice(-300)}`);
  const lost = await kit.git(c2, 'push', 'origin', 'main');
  Object.assign(metrics, { conflict_first_ms: won.ms, conflict_second_ms: lost.ms });
  metrics.conflict_said = lost.stderr.split('\n').filter((l) => /conflict|refused/i.test(l)).join(' | ').slice(0, 300);
  assert.notEqual(lost.code, 0, 'The second same-line push landed');
  assert.match(lost.stderr, /conflict in README\.md/, `The refusal does not name README.md: ${lost.stderr.slice(-300)}`);
  const unchanged = await refsOf(kit, repo);
  assert.equal(unchanged.refs[MAIN], await kit.gitOk(c1, 'rev-parse', 'HEAD'), 'main moved on a refused push');
  const pulled = await kit.git(c2, 'pull', '--no-rebase', 'origin', 'main');
  assert.notEqual(pulled.code, 0, 'git pull merged a same-line conflict without stopping');
  write(c2, 'README.md', readme('clone-one+clone-two'));
  await kit.gitOk(c2, 'add', 'README.md');
  await kit.gitOk(c2, 'commit', '-q', '--no-edit');
  const resolved = await kit.git(c2, 'push', 'origin', 'main');
  metrics.resolved_push_ms = resolved.ms;
  assert.equal(resolved.code, 0, `The resolved push failed: ${resolved.stderr.slice(-300)}`);
  const final = await refsOf(kit, repo);
  metrics.resolved_head_is_local = final.refs[MAIN] === (await kit.gitOk(c2, 'rev-parse', 'HEAD'));
  assert.ok(metrics.resolved_head_is_local, 'main is not the pushed merge commit');
  await kit.gitOk(c1, 'pull', '-q', '--ff-only', 'origin', 'main');
  state.readmeChanged = true;
}

/** 14: an atomic push with one stale branch moves neither; a killed push moves nothing. */
export async function cliTransactional(kit, state, metrics) {
  if (!state.repo) return { skip: 'No CLI repository (item 12)' };
  const { repo, c1, c2 } = state;
  for (const branch of ['kit-a', 'kit-b']) {
    await kit.gitOk(c1, 'checkout', '-q', '-B', branch, 'main');
    write(c1, `${branch}.txt`, `${branch} 1\n`);
    await commitAll(kit, c1, `Kit: ${branch}`);
  }
  await kit.ok('git', ['push', 'origin', 'kit-a', 'kit-b'], { cwd: c1 });
  // Clone two moves kit-b, so clone one's kit-b is stale.
  await kit.gitOk(c2, 'fetch', '-q', 'origin');
  await kit.gitOk(c2, 'checkout', '-q', '-B', 'kit-b', 'origin/kit-b');
  write(c2, 'kit-b.txt', 'kit-b from clone two\n');
  await commitAll(kit, c2, 'Kit: kit-b moved by clone two');
  await kit.ok('git', ['push', 'origin', 'kit-b'], { cwd: c2 });
  for (const branch of ['kit-a', 'kit-b']) {
    await kit.gitOk(c1, 'checkout', '-q', branch);
    write(c1, `${branch}.txt`, `${branch} 2\n`);
    await commitAll(kit, c1, `Kit: ${branch} again`);
  }
  const before = await refsOf(kit, repo);
  const atomic = await kit.git(c1, 'push', '--atomic', 'origin', 'kit-a', 'kit-b');
  const after = await refsOf(kit, repo);
  Object.assign(metrics, { atomic_exit: atomic.code, atomic_ms: atomic.ms, atomic_said: atomic.stderr.split('\n').filter((l) => /kit-|atomic|rejected|refused/.test(l)).join(' | ').slice(0, 300) });
  assert.notEqual(atomic.code, 0, 'The atomic push with a stale branch succeeded');
  assert.deepEqual(after, before, 'An atomic push with a stale branch changed refs or the version');
  // The same all-or-none rule at the server: a batch with one stale expectation moves neither.
  const stale = await kit.pat().raw('POST', `/repos/${repo}/refs/batch`, {
    updates: [
      { ref: 'refs/heads/kit-a', commit: before.refs[MAIN], expected: before.refs['refs/heads/kit-a'] },
      { ref: 'refs/heads/kit-b', commit: before.refs[MAIN], expected: state.commit12 },
    ],
  });
  metrics.batch_refusal = `${stale.status} ${stale.body?.error?.code ?? ''} stale=${JSON.stringify(stale.body?.error?.details?.stale ?? null)}`;
  assert.equal(stale.body?.error?.code, 'STALE_HEAD', `refs/batch with a stale head: ${metrics.batch_refusal}`);
  assert.deepEqual(await refsOf(kit, repo), before, 'A refused refs/batch changed refs or the version');
  await killedPush(kit, state, metrics);
}

/** Kills `git push` (and its helper) once its uploads are done, before the landing CAS. */
async function killedPush(kit, { repo, c1 }, metrics) {
  await kit.gitOk(c1, 'checkout', '-q', 'main');
  await kit.gitOk(c1, 'pull', '-q', '--ff-only', 'origin', 'main');
  write(c1, 'killed/push.txt', 'a push that was killed before its landing\n');
  const local = await commitAll(kit, c1, 'Kit: killed push');
  const before = await refsOf(kit, repo);
  let child;
  const proxy = await casKillingProxy(kit.api, async () => {
    process.kill(-child.pid, 'SIGKILL');
  });
  try {
    const killed = await kit.run('git', ['push', kit.remote(repo, proxy.origin), 'HEAD:refs/heads/main'], {
      cwd: c1,
      detached: true,
      onSpawn: (c) => (child = c),
    });
    Object.assign(metrics, { killed_signal: killed.signal ?? `exit ${killed.code}`, killed_at: proxy.seen.intercepted, uploads_before_kill: proxy.seen.forwarded.filter((r) => r.startsWith('POST')).length });
    metrics.killed_requests = proxy.seen.forwarded;
    assert.ok(proxy.seen.intercepted, `The push never reached its final CAS: ${killed.stderr.slice(-300)}`);
    assert.ok(metrics.uploads_before_kill > 0, 'Nothing was uploaded before the kill');
    assert.ok(!groupAlive(child.pid), 'git or the helper survived SIGKILL');
  } finally {
    await proxy.close();
  }
  const after = await refsOf(kit, repo);
  assert.deepEqual(after, before, 'A killed push changed refs or the log version');
  const repushed = await kit.ok('git', ['push', 'origin', 'main'], { cwd: c1 });
  metrics.repush_ms = repushed.ms;
  const landed = await refsOf(kit, repo);
  assert.equal(landed.refs[MAIN], local, 'The re-push did not land the killed commit');
  assert.ok(landed.version > before.version, 'The re-push did not advance the log version');
}
