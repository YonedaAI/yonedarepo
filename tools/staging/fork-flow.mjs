// Forks live gate (kit item 22): the kit account shares a fresh repository with the second
// kit account (`<kit username>_m`, as the members gate) at read. The second account forks it
// (POST /fork), pushes a branch to its fork with stock Git over smart HTTP, and opens a
// change on the parent from that branch (POST /changes {fork, branch}); the owner approves
// the head and lands it on main; a fresh stock-Git clone of the parent holds the commit and
// its file bytes. The parent refuses deletion (409) while the fork exists; the fork goes
// first. Personal and repository tokens reach Git only through the environment
// (http.extraHeader), never an argument; both are revoked or deleted with their repository.
//
// Usage: node tools/staging-realworld.mjs --forks [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64, secondAccount } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };

/** `kit`: the kit credentials; the forking account is derived from them. */
export async function forkFlow({ origin, api, kit, platform }, metrics) {
  const { name: memberName, session: member } = await secondAccount(origin, kit);
  const name = `kit-forks-${Date.now()}`;
  const parent = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 1 }, files: [{ path: 'README.md', content_b64: b64('# Forks\n') }], author });
  const path = `/repos/${parent.id}`;
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-forks-'));
  writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Staging kit member\n\temail = member@yonedarepo.invalid\n');
  /** Stock Git with `token` in the environment only. */
  const git = (token, args, cwd = dir) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    };
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
    } catch (e) {
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? e.message}`.slice(-600) };
    }
  };
  let fork = null;
  let pat = null;
  try {
    assert.equal((await member.raw('POST', `${path}/fork`, {})).status, 403, 'no read, no fork');
    await platform.post(`${path}/members`, { account: memberName, role: 'read' });

    // The fork: owned by the second account, its refs the parent's.
    const forkStarted = performance.now();
    fork = await member.post(`${path}/fork`, { name: `${name}-fork` });
    metrics.fork_ms = Math.round(performance.now() - forkStarted);
    metrics.fork = fork.id;
    const forkStatus = await member.get(`/repos/${fork.id}`);
    assert.equal(forkStatus.parent?.repo, parent.id, 'the fork names its parent');
    assert.equal((await member.get(`/repos/${fork.id}/refs`)).refs['refs/heads/main'], parent.commit, "the fork's main is the parent's");

    // A branch pushed to the fork with stock Git (the token reads the parent too: a push
    // relies on the history the fork inherits).
    pat = await member.post('/tokens', { name: `kit-forks-${Date.now()}`, scopes: ['repo:read', 'repo:write'], repos: [parent.id, fork.id], expires_days: 1 });
    const cloned = git(pat.token, ['clone', '-q', `${api}/git/${fork.id}.git`, 'fork']);
    assert.ok(cloned.ok, `clone of the fork: ${cloned.out}`);
    const work = join(dir, 'fork');
    const content = `from the fork ${Date.now()}\n`;
    writeFileSync(join(work, 'forked.txt'), content);
    git(pat.token, ['add', '-A'], work);
    git(pat.token, ['commit', '-q', '-m', 'Work from a fork'], work);
    const head = git(pat.token, ['rev-parse', 'HEAD'], work).out;
    const pushed = git(pat.token, ['push', '-q', 'origin', 'HEAD:refs/heads/kit-fork'], work);
    assert.ok(pushed.ok, `push to the fork: ${pushed.out}`);

    // The change on the parent, from the fork's branch, by its reader.
    const opened = await member.post(`${path}/changes`, { fork: fork.id, branch: 'kit-fork', title: 'Work from a fork' });
    assert.deepEqual([opened.head, opened.branch, opened.source_repo], [head, `forks/${fork.id}/kit-fork`, fork.id], 'the change proposes the fork head');
    metrics.change = opened.number;
    const shown = await platform.get(`${path}/changes/${opened.number}`);
    assert.deepEqual(shown.diff?.changes?.map((c) => c.path), ['forked.txt'], 'the change shows the fork commit');

    // The owner approves and lands it.
    await platform.post(`${path}/commits/${head}/reviews`, { decision: 'approve' });
    const landed = await platform.post(`${path}/land`, { ref: 'main', commit: head });
    metrics.landed_version = landed.version;
    assert.equal((await platform.get(`${path}/changes/${opened.number}`)).status, 'landed');

    // A fresh clone of the parent holds the fork's commit, byte for byte.
    const reader = await platform.post(`${path}/tokens`, { name: 'kit-forks-clone', scopes: ['read'] });
    const fresh = git(reader.token, ['clone', '-q', `${api}/git/${parent.id}.git`, 'parent']);
    assert.ok(fresh.ok, `fresh clone of the parent: ${fresh.out}`);
    const log = git(reader.token, ['log', '--format=%H', 'origin/main'], join(dir, 'parent')).out.split('\n');
    assert.ok(log.includes(head), "the parent's main holds the fork commit");
    assert.equal(readFileSync(join(dir, 'parent', 'forked.txt'), 'utf8'), content, 'file bytes match');
    metrics.parent_commits = log.length;

    // The parent goes only after its fork.
    metrics.parent_delete_with_fork = (await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`)).status;
    assert.equal(metrics.parent_delete_with_fork, 409, 'a parent with a fork is not deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (pat) await member.raw('DELETE', `/tokens/${pat.id}`);
    if (fork) await member.raw('DELETE', `/repos/${fork.id}?confirm=${encodeURIComponent(fork.name)}`);
    metrics.parent_delete = (await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`)).status;
  }
  assert.equal(metrics.parent_delete, 200, 'the parent is deleted after its fork');
}
