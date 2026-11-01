// The undo window, live on dev (dev-checks.mjs), with REPO_UNDO_DAYS set to a short test window
// and labelled as one. A public repository with a member, a token and an LFS file is deleted:
// through the window API and Git answer as for a deleted repository while every copy stays. It
// is restored inside the window, under a new name because its own was taken meanwhile, with its
// content, date and member back and its old token still dead. Deleted again and left, the purge
// comes after the due time, a restore is refused, and every copy goes.
import assert from 'node:assert/strict';
import { copiesLeft, proofTable, shortWindow } from './dev-checks-lib.mjs';
import { fileOf, locateObject, newRepo, noteStore, purgeNow, refused, remove, repoPath, snapshot, waitErased, waitFor } from './dev-checks-repos.mjs';

const FILES = [fileOf('a.txt', 'first file\n'), fileOf('dir/b.txt', 'second file\n'), fileOf('README.md', '# Dev check, safe to delete\n')];
/** After the due time: one sweep a minute, the queue, then the purge itself. */
const PURGE_GRACE_MS = 300_000;

const restoreOf = (session, repo, body = {}) => session.raw('POST', repoPath(repo, '/restore'), body);
const listed = async (session, repo) => (await session.get('/repos')).repos.find((r) => r.id === repo.id);
const inDeleted = async (session, repo) => (await session.get('/repos/deleted')).repos.find((r) => r.id === repo.id);
const rows = async (ctx, repo, table) => (await ctx.cf.d1(`SELECT COUNT(*) AS n FROM ${table} WHERE id=?`, [repo.id]))[0].n;

/** What API and Git say of `repo` while it is deleted, for each kind of caller. */
async function goneToEveryone(ctx, repo, tokenSession, metrics) {
  refused('owner read', await ctx.owner.raw('GET', repoPath(repo)), 404, 'GONE');
  refused('owner file read', await ctx.owner.raw('GET', repoPath(repo, '/blob?path=a.txt')), 404, 'GONE');
  refused('owner refs', await ctx.owner.raw('GET', repoPath(repo, '/refs')), 404, 'GONE');
  refused('anonymous read', await ctx.anon.raw('GET', repoPath(repo)), 404, 'GONE', 'NOT_FOUND');
  refused('member read', await ctx.member.raw('GET', repoPath(repo)), 404, 'GONE', 'NOT_FOUND');
  const byToken = await tokenSession.raw('GET', repoPath(repo));
  assert.ok([401, 404].includes(byToken.status), `the old token read: ${byToken.status}`);
  metrics.old_token = byToken.status;
  const anonymous = await ctx.git.clone(repo, null);
  assert.equal(anonymous.ok, false, 'an anonymous clone is refused');
  const withToken = await ctx.git.clone(repo, repo.token);
  assert.equal(withToken.ok, false, 'a clone with the old token is refused');
}

export function undoSteps(ctx) {
  const s = {};
  return [
    ['U1', 'A repository with a member, a token and an LFS file', async (m) => {
      s.window = shortWindow((await ctx.owner.get('/repos/deleted')).window_days);
      m.window = s.window.label;
      s.repo = await newRepo(ctx, 'undo', { visibility: 'public', files: FILES, tokens: [{ name: 'old', scopes: ['read', 'write', 'land'] }] });
      await ctx.owner.post(repoPath(s.repo, '/members'), { account: ctx.memberName, role: 'read' });
      await noteStore(ctx, s.repo);
      s.oldToken = ctx.bearer(s.repo.token);
      s.work = await ctx.git.work(s.repo, s.repo.token);
      await ctx.git.pushLfs(s.work, s.repo.token);
      s.created_at = (await listed(ctx.owner, s.repo)).created_at;
      s.before = await ctx.git.fingerprint(s.repo, s.repo.token);
      s.copies = await waitFor(ctx, async () => {
        const seen = await snapshot(ctx, s.repo);
        return seen.r2[`platform/v1/${s.repo.id}/`].keys > 0 ? seen : null;
      }, { timeoutMs: 120_000, intervalMs: 5000, what: 'its objects in R2' });
      Object.assign(m, { repo: s.repo.id, commits: s.before.commits, lfs: Object.keys(s.copies.r2[`platform/v1/${s.repo.id}/`].kinds).includes('lfs') });
    }],
    ['U2', 'In the window: everyone is told it is gone, and every copy stays', async (m) => {
      await remove(ctx, s.repo);
      await locateObject(ctx, s.repo);
      await goneToEveryone(ctx, s.repo, s.oldToken, m);
      assert.ok(!(await listed(ctx.owner, s.repo)), 'off the owner\'s list');
      s.entry = await inDeleted(ctx.owner, s.repo);
      assert.ok(s.entry, 'in Recently deleted');
      assert.ok(Math.abs(s.entry.purge_at - s.entry.deleted_at - s.window.ms) < 5000, `due after the window: ${s.entry.purge_at - s.entry.deleted_at} ms`);
      assert.ok(!(await inDeleted(ctx.member, s.repo)), 'not in a member\'s Recently deleted');
      assert.equal(await rows(ctx, s.repo, 'platform_repos'), 0, 'unlisted in D1');
      assert.equal(await rows(ctx, s.repo, 'platform_deleted_repos'), 1, 'on the schedule in D1');
      const during = await snapshot(ctx, s.repo);
      const prefix = `platform/v1/${s.repo.id}/`;
      assert.equal(during.r2[prefix].keys, s.copies.r2[prefix].keys, 'R2 keeps every object through the window');
      if (s.copies.artifacts) assert.equal(during.artifacts.exists, s.copies.artifacts.exists, 'the mirror stays');
      assert.equal(during.object.state, 'tombstone', 'the object is a tombstone');
      s.objectBefore = during.object;
      Object.assign(m, { r2_keys_kept: during.r2[prefix].keys, purge_at: s.entry.purge_at });
    }],
    ['U3', 'Restored inside the window, content intact, old token dead', async (m) => {
      refused('a member restoring', await restoreOf(ctx.member, s.repo), 404, 'GONE');
      const original = s.repo.name;
      s.other = await newRepo(ctx, 'undo-name', { name: original, files: FILES });
      refused('its name taken', await restoreOf(ctx.owner, s.repo), 409, 'NAME_TAKEN');
      const back = await restoreOf(ctx.owner, s.repo, { name: `${original}-back` });
      assert.equal(back.status, 200, `restore: ${back.status} ${back.body?.error?.code}`);
      assert.equal(back.body.restored, true);
      assert.ok(ctx.clock.now() < s.entry.purge_at, 'restored inside the window');
      s.repo.name = `${original}-back`;
      s.repo.deleted = false;
      m.restored_ms_before_due = s.entry.purge_at - ctx.clock.now();
      const fresh = await ctx.owner.post(repoPath(s.repo, '/tokens'), { name: 'new', scopes: ['read', 'write', 'land'] });
      ctx.secrets.add(fresh.token);
      assert.deepEqual(await ctx.git.fingerprint(s.repo, fresh.token), s.before, 'the same commits and bytes');
      assert.equal((await listed(ctx.owner, s.repo))?.created_at, s.created_at, 'its first date');
      refused('the old token', await s.oldToken.raw('GET', repoPath(s.repo)), 401);
      assert.equal((await ctx.member.raw('GET', repoPath(s.repo))).status, 200, 'its member reads');
      const pushed = await ctx.git.pushFile(s.work, fresh.token, 'after-restore.txt', 'still writable\n');
      assert.ok(pushed.ok, `a push after the restore: ${pushed.error}`);
      assert.equal(await rows(ctx, s.repo, 'platform_deleted_repos'), 0, 'off the schedule');
      assert.ok(!(await inDeleted(ctx.owner, s.repo)), 'out of Recently deleted');
      await remove(ctx, s.other);
      await purgeNow(ctx, s.other);
    }],
    ['U4', 'Past the window: purged, a restore refused, every copy gone', async (m) => {
      await remove(ctx, s.repo);
      const entry = await inDeleted(ctx.owner, s.repo);
      assert.ok(entry, 'in Recently deleted again');
      const left = entry.purge_at - ctx.clock.now();
      if (left > 0) await ctx.clock.sleep(left);
      await waitFor(ctx, async () => (await rows(ctx, s.repo, 'platform_deleted_repos')) === 0, {
        timeoutMs: PURGE_GRACE_MS,
        intervalMs: 5000,
        what: 'the purge after the due time',
      });
      m.purged_s_after_due = Math.round((ctx.clock.now() - entry.purge_at) / 1000);
      refused('a restore after the purge', await restoreOf(ctx.owner, s.repo), 404, 'GONE');
      await waitErased(ctx, s.repo);
      const after = await snapshot(ctx, s.repo);
      assert.deepEqual(copiesLeft(after), [], 'nothing is left');
      m.proof = proofTable({ ...s.copies, object: s.objectBefore }, after);
      refused('a read after the purge', await ctx.owner.raw('GET', repoPath(s.repo)), 404, 'GONE');
      assert.equal((await ctx.git.clone(s.repo, null)).ok, false, 'a clone after the purge is refused');
    }],
  ];
}
