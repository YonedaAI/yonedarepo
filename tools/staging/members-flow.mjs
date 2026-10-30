// Repository members live gate (B5) for the staging kit: the kit account shares a fresh
// repository with a second kit account (`<kit username>_m`, same private password file,
// signed up on first use) and raises its role step by step. Passes when the member sees the
// repository in its listing, reads and clones with stock Git at read, is refused a push,
// pushes a branch with stock Git at write, approves and lands the owner's commit at land
// (but never approves its own), is refused admin-only steps as admin, and loses REST and Git
// access at once when removed. The member's personal token reaches Git only through the
// environment (http.extraHeader), never an argument; it is revoked at the end.
//
// Usage: node tools/staging-realworld.mjs --members [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64, secondAccount } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };

/** `kit`: the kit credentials; the member account is derived from them. */
export async function membersFlow({ origin, api, kit, platform }, metrics) {
  const { name: memberName, session: member } = await secondAccount(origin, kit);
  const name = `kit-members-${Date.now()}`;
  const repo = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 1 }, files: [{ path: 'README.md', content_b64: b64('# Members\n') }], author });
  const path = `/repos/${repo.id}`;
  const role = (r) => platform.post(`${path}/members`, { account: memberName, role: r });
  const status = async (session, method, url, body) => (await session.raw(method, url, body)).status;
  const pat = await member.post('/tokens', { name: `kit-members-${Date.now()}`, scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:review'], repos: [repo.id], expires_days: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-members-'));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${pat.token}`,
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Staging kit member\n\temail = member@yonedarepo.invalid\n');
  const remote = `${api}/git/${repo.id}.git`;
  const git = (args, cwd = dir) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
    } catch (e) {
      return { ok: false, out: String(e.stderr ?? e.message).slice(-400) };
    }
  };
  try {
    assert.equal(await status(member, 'GET', `${path}/refs`), 404, 'a private repository is not found by a stranger');
    assert.equal((await platform.raw('POST', `${path}/members`, { account: `${memberName}_nobody`, role: 'read' })).status, 404, 'an unknown account is refused');

    // read: listed with its role, reads and clones, can't push.
    await role('read');
    const listed = (await member.get('/repos')).repos.find((r) => r.id === repo.id);
    assert.deepEqual([listed?.role, listed?.owner], ['read', kit.KIT_ACCOUNT ?? kit.KIT_USERNAME], 'the shared repository is listed');
    const cloned = git(['clone', '-q', remote, 'work']);
    assert.ok(cloned.ok, `clone at read: ${cloned.out}`);
    const work = join(dir, 'work');
    writeFileSync(join(work, 'member.txt'), 'member\n');
    git(['add', '-A'], work);
    git(['commit', '-q', '-m', 'member branch'], work);
    const refusedPush = git(['push', '-q', 'origin', 'HEAD:refs/heads/kit-member'], work);
    assert.ok(!refusedPush.ok && /403|FORBIDDEN|lacks/.test(refusedPush.out), `push at read is refused: ${refusedPush.out}`);

    // write: the same push lands on a branch; main still needs land.
    await role('write');
    const pushed = git(['push', '-q', 'origin', 'HEAD:refs/heads/kit-member'], work);
    assert.ok(pushed.ok, `push at write: ${pushed.out}`);
    const branchHead = git(['rev-parse', 'HEAD'], work).out;
    assert.equal((await member.get(`${path}/refs`)).refs['refs/heads/kit-member'], branchHead);
    const own = await member.post(`${path}/commits`, { ref: 'main', changes: [{ path: 'own.txt', content_b64: b64('own\n') }], message: 'member own', author });
    assert.equal(await status(member, 'POST', `${path}/land`, { ref: 'main', commit: own.commit }), 403, 'landing main needs land');

    // land: approves and lands the owner's commit; never approves its own.
    await role('land');
    const owners = await platform.post(`${path}/commits`, { ref: 'main', changes: [{ path: 'owner.txt', content_b64: b64('owner\n') }], message: 'owner change', author });
    assert.equal(await status(member, 'POST', `${path}/commits/${own.commit}/reviews`, { decision: 'approve' }), 403, 'self-approval is refused');
    await member.post(`${path}/commits/${owners.commit}/reviews`, { decision: 'approve' });
    const landed = await member.post(`${path}/land`, { ref: 'main', commit: owners.commit });
    metrics.landed_version = landed.version;

    // admin: manages tokens and members, never admins, never deletes.
    await role('admin');
    assert.equal(await status(member, 'GET', `${path}/tokens`), 200, 'an admin lists tokens');
    assert.equal(await status(member, 'POST', `${path}/members`, { account: memberName, role: 'admin' }), 403, 'an admin cannot manage admins');
    assert.equal(await status(member, 'DELETE', `${path}?confirm=${encodeURIComponent(name)}`), 403, 'an admin cannot delete');

    // Removal ends access at once: REST and stock Git.
    const removed = performance.now();
    await platform.call('DELETE', `${path}/members/${memberName}`);
    assert.equal(await status(member, 'GET', `${path}/tree?path=`), 404, 'REST refused (not found) after removal');
    const fetched = git(['fetch', '-q', 'origin'], work);
    assert.ok(!fetched.ok, 'Git refused after removal');
    metrics.revoke_ms = Math.round(performance.now() - removed);
    assert.ok(!(await member.get('/repos')).repos.some((r) => r.id === repo.id), 'unlisted after removal');
    metrics.repo = repo.id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await member.raw('DELETE', `/tokens/${pat.id}`);
    await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`);
  }
}
