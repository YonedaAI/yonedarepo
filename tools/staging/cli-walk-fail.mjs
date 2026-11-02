// Kit item 48: the failures a person meets. Each must exit non-zero, say what to do in plain words,
// change nothing, and carry a stable code under --json.
import assert from 'node:assert/strict';
import { flowRepo } from './cli-walk-land.mjs';
import { plain, short } from './cli-walk-kit.mjs';

const NO_SUCH_REPO = 'r00000000000000000000';

/** `--json` refuses with `yoneda.cli.error.v1` and this code on stdout. */
async function jsonError(w, person, args, code, options) {
  const ran = await person.y([...args, '--json'], options);
  assert.notEqual(ran.code, 0, `${args.join(' ')} succeeded`);
  assert.equal(w.document(ran.stdout, args).code, code, ran.stdout);
}

async function wrongRepoRows(w, me) {
  await w.row('wrong repo: an id that does not exist', async () => {
    await me.refused(['log', '--repo', NO_SUCH_REPO], 1, /NOT_FOUND|not found/i);
    await jsonError(w, me, ['log', '--repo', NO_SUCH_REPO], 'not_found');
  });
  await w.row('wrong repo: not an id', async () => {
    await me.refused(['log', '--repo', 'mlong/whatever'], 64, /is not a repository id/);
  });
  await w.row('wrong repo: clone an id that does not exist', async () => {
    const ran = await me.refused(['clone', NO_SUCH_REPO, 'nope'], 1, /NOT_FOUND|not found/i);
    assert.doesNotMatch(ran.stderr, /git clone -q/, `the refusal is Git's plumbing: ${short(ran.stderr)}`);
  });
  await w.row('no repository named, outside a clone', async () => {
    await me.refused(['log'], 64, /no repository: pass --repo <id> or run this inside a yoneda clone/, { cwd: '/' });
    await jsonError(w, me, ['log'], 'usage', { cwd: '/' });
  });
  await w.row('wrong platform: nothing answers', async () => {
    const ran = await me.y(['repo', 'list', '--origin', 'https://nothing.invalid']);
    assert.notEqual(ran.code, 0, 'it answered');
    plain(ran.stderr);
    assert.match(ran.stderr, /login|cannot reach/i, short(ran.stderr));
  });
  await w.row('repo delete: wrong name, then no access', async () => {
    const repo = await flowRepo(w, me, 'delete-me');
    await me.refused(['repo', 'delete', repo.id, '--confirm', 'wrong'], 1, /CONFIRM|confirm|name/i);
    assert.equal((await me.api.raw('GET', `/repos/${repo.id}`)).status, 200, 'a wrong name deleted it');
    await me.refused(['repo', 'delete', repo.id], 64, /needs --confirm/);
    const out = await me.j(['repo', 'delete', repo.id, '--confirm', repo.name]);
    assert.equal(out.id, repo.id);
    w.repos = w.repos.filter((r) => r.id !== repo.id);
    assert.ok([404, 410].includes((await me.api.raw('GET', `/repos/${repo.id}/refs`)).status), 'it still answers');
    assert.ok(!(await me.j(['repo', 'list'])).repos.some((r) => r.id === repo.id), 'still listed');
  });
}

async function permissionRows(w, me, stranger, tree) {
  const says = /NOT_FOUND|not found|FORBIDDEN/i;
  await w.rowOf('no permission: a stranger on a private repository', stranger.token, 'The second login', async () => {
    await stranger.refused(['log', '--repo', tree.id], 1, says);
    await stranger.refused(['change', 'list', '--repo', tree.id], 1, says);
    await stranger.refused(['repo', 'delete', tree.id, '--confirm', tree.name], 1, says);
    await stranger.refused(['repo', 'fork', tree.id], 1, says);
    await jsonError(w, stranger, ['log', '--repo', tree.id], 'not_found');
    assert.equal((await me.api.raw('GET', `/repos/${tree.id}`)).status, 200, 'the repository went');
  });
  await w.rowOf('no permission: a stranger\'s clone and push', stranger.token, 'The second login', async () => {
    const clone = await stranger.git(stranger.home, 'clone', `yoneda::${w.api}/${tree.id}`, 'nope');
    assert.notEqual(clone.code, 0, 'a stranger cloned a private repository');
    plain(clone.stderr);
    assert.match(clone.stderr, says, short(clone.stderr));
    const dir = stranger.path('own');
    await stranger.gitOk(stranger.home, 'init', '-q', 'own');
    await stranger.commit(dir, { 'x.txt': 'x\n' }, 'Intruder');
    const before = (await me.api.get(`/repos/${tree.id}/refs`)).refs;
    const push = await stranger.git(dir, 'push', `yoneda::${w.api}/${tree.id}`, 'main');
    assert.notEqual(push.code, 0, 'a stranger pushed');
    assert.deepEqual((await me.api.get(`/repos/${tree.id}/refs`)).refs, before, 'refs moved');
  });
}

async function signInRows(w, me, tree) {
  await w.row('no sign-in', async () => {
    const nobody = w.person('nobody');
    await nobody.refused(['repo', 'list', '--origin', w.api], 1, /yoneda login/);
    await jsonError(w, nobody, ['repo', 'list', '--origin', w.api], 'auth');
  });
  const gone = w.person('gone');
  const dir = gone.path('copy');
  await w.row('expired sign-in: yoneda says to sign in again', async () => {
    await gone.login();
    await gone.gitOk(gone.home, 'clone', '-q', `yoneda::${w.api}/${tree.id}`, dir);
    assert.equal((await gone.signOut()).status, 200, 'the sign-out failed');
    w.tokens = w.tokens.filter((token) => token !== gone.token);
    await w.soon(async () => (await gone.y(['repo', 'list'])).code !== 0, 'the revoked token to stop');
    await jsonError(w, gone, ['repo', 'list'], 'auth');
    await gone.refused(['repo', 'list'], 1, /yoneda login/);
  });
  await w.row('expired sign-in: git push says to sign in again', async () => {
    await gone.commit(dir, { 'late.txt': 'late\n' }, 'Late');
    const push = await gone.git(dir, 'push', 'origin', 'main');
    assert.notEqual(push.code, 0, 'a revoked token pushed');
    assert.match(push.stderr, /yoneda login/, `git push does not say to sign in again: ${short(push.stderr)}`);
  });
  await w.row('a bad token in YONEDA_TOKEN', async () => {
    await me.refused(['repo', 'list'], 1, /yoneda login|token/i, { env: me.env({ YONEDA_TOKEN: 'ypat_nonsense' }) });
  });
}

async function staleRows(w, me) {
  const repo = await flowRepo(w, me, 'stale');
  const other = me.path('stale-other');
  await me.gitOk(me.home, 'clone', '-q', `yoneda::${w.api}/${repo.id}`, other);
  await w.row('stale push: disjoint work is merged by the server', async () => {
    await me.commit(other, { 'theirs.txt': 'theirs\n' }, 'Theirs');
    await me.gitOk(other, 'push', '-q', 'origin', 'main');
    await me.commit(repo.dir, { 'ours.txt': 'ours\n' }, 'Ours');
    const push = await me.git(repo.dir, 'push', 'origin', 'main');
    assert.equal(push.code, 0, short(push.stderr));
    await me.gitOk(other, 'pull', '-q', 'origin', 'main');
    for (const file of ['ours.txt', 'theirs.txt']) await me.gitOk(other, 'cat-file', '-e', `HEAD:${file}`);
  });
  await w.row('stale push: a stale branch is refused, nothing moves', async () => {
    await me.gitOk(repo.dir, 'pull', '-q', 'origin', 'main');
    await me.gitOk(repo.dir, 'checkout', '-q', '-b', 'shared');
    await me.commit(repo.dir, { 'shared.txt': 'one\n' }, 'One');
    await me.gitOk(repo.dir, 'push', '-q', 'origin', 'shared');
    await me.gitOk(other, 'fetch', '-q', 'origin');
    await me.gitOk(other, 'checkout', '-q', '-b', 'shared', 'origin/shared');
    await me.commit(other, { 'shared.txt': 'two\n' }, 'Two');
    await me.gitOk(other, 'push', '-q', 'origin', 'shared');
    const moved = (await repo.refs())['refs/heads/shared'];
    await me.commit(repo.dir, { 'shared.txt': 'three\n' }, 'Three');
    const push = await me.git(repo.dir, 'push', 'origin', 'shared');
    assert.notEqual(push.code, 0, 'a stale branch push landed');
    assert.match(push.stderr, /rejected|stale|fetch first|non-fast-forward/i, short(push.stderr));
    assert.equal((await repo.refs())['refs/heads/shared'], moved, 'the branch moved');
  });
  await w.row('a Git repository with no yoneda remote', async () => {
    const dir = me.path('no-remote');
    await me.gitOk(me.home, 'init', '-q', 'no-remote');
    await me.commit(dir, { 'a.txt': 'a\n' }, 'A');
    await me.refused(['status'], 1, /no yoneda remote/, { cwd: dir });
    await me.refused(['log'], 64, /no repository/, { cwd: dir });
  });
}

export async function failureRowsAll(w, me, stranger, tree) {
  await wrongRepoRows(w, me);
  await permissionRows(w, me, stranger, tree);
  await signInRows(w, me, tree);
  await staleRows(w, me);
}
