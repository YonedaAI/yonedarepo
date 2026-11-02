// Kit item 48: moving main with the CLI: land, rebase, conflicts, policy and reviews on a throwaway
// repository, each read back over the API and with a fresh look at main.
import assert from 'node:assert/strict';

const MAIN = 'refs/heads/main';

/** Fresh repository `what`, cloned to a folder of that name, with one file on main. */
export async function flowRepo(w, me, what, files = { 'README.md': 'line one\nline two\n' }) {
  const name = w.name(what);
  const made = await me.j(['repo', 'create', name]);
  w.repos.push({ id: made.id, name });
  const dir = me.path(what);
  await me.gitOk(me.home, 'clone', '-q', `yoneda::${w.api}/${made.id}`, dir);
  const head = await me.commit(dir, files, 'Seed');
  await me.gitOk(dir, 'push', '-q', 'origin', 'main');
  const refs = async () => (await me.api.get(`/repos/${made.id}/refs`)).refs;
  return { id: made.id, name, dir, head, refs, main: async () => (await refs())[MAIN] };
}

/** A branch `name` off main with `files` committed and pushed; back on main. */
export async function branch(me, repo, name, files, message = `Work on ${name}`) {
  await me.gitOk(repo.dir, 'checkout', '-q', '-B', name, 'origin/main');
  const head = await me.commit(repo.dir, files, message);
  await me.gitOk(repo.dir, 'push', '-q', '-f', 'origin', name);
  await me.gitOk(repo.dir, 'checkout', '-q', 'main');
  return head;
}

async function landRows(w, me) {
  const repo = await flowRepo(w, me, 'land');
  await w.row('land --branch', async () => {
    const head = await branch(me, repo, 'one', { 'one.txt': 'one\n' });
    const out = await me.j(['land', '--branch', 'one', '--repo', repo.id]);
    assert.equal(out.head, head);
    assert.equal(await repo.main(), head, 'main did not move to the head');
    assert.equal(out.base, 'main');
    assert.ok(out.version > 0, 'no version');
  });
  await w.row('land (the clone\'s branch)', async () => {
    await me.gitOk(repo.dir, 'pull', '-q', 'origin', 'main');
    const head = await branch(me, repo, 'two', { 'two.txt': 'two\n' });
    await me.gitOk(repo.dir, 'checkout', '-q', 'two');
    const ran = await me.ok(['land'], { cwd: repo.dir });
    assert.match(ran.stdout, new RegExp(`^Landed two \\(${head}\\) on main at version \\d+`, 'm'), ran.stdout);
    assert.equal(await repo.main(), head);
    await me.gitOk(repo.dir, 'checkout', '-q', 'main');
  });
  await w.row('land refuses main and an unknown branch', async () => {
    await me.refused(['land'], 64, /main is the landing target/, { cwd: repo.dir });
    await me.refused(['land', '--branch', 'nobody', '--repo', repo.id], 1, /has no branch nobody; git push it first/);
    await me.refused(['land', '--repo', repo.id], 64, /land needs --branch/);
  });
  await w.row('land a conflict: exit 2, its paths, main stays', async () => {
    await me.gitOk(repo.dir, 'pull', '-q', 'origin', 'main');
    await branch(me, repo, 'left', { 'README.md': 'left\nline two\n' });
    await branch(me, repo, 'right', { 'README.md': 'right\nline two\n' });
    await me.ok(['land', '--branch', 'left', '--repo', repo.id]);
    const main = await repo.main();
    const ran = await me.refused(['land', '--branch', 'right', '--repo', repo.id], 2, /conflicting: README\.md/);
    assert.equal(await repo.main(), main, 'a refused landing moved main');
    return ran.stderr.split('\n')[0];
  });
  return repo;
}

async function conflictRows(w, me, repo) {
  await w.row('conflicts (nothing refused)', async () => {
    const out = await me.j(['conflicts'], { cwd: repo.dir });
    assert.equal(out.refused, false, JSON.stringify(out));
    assert.match((await me.ok(['conflicts'], { cwd: repo.dir })).stdout, /No refused landing recorded/);
    await me.refused(['conflicts'], 64, /conflicts runs inside a clone/, { cwd: '/' });
  });
  await w.row('conflicts (after a refused push), status says so', async () => {
    const dir = repo.dir;
    await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
    const other = me.path('land-other');
    await me.gitOk(me.home, 'clone', '-q', `yoneda::${w.api}/${repo.id}`, other);
    await me.commit(other, { 'README.md': 'theirs\nline two\n' }, 'Theirs');
    await me.gitOk(other, 'push', '-q', 'origin', 'main');
    await me.commit(dir, { 'README.md': 'ours\nline two\n' }, 'Ours');
    const push = await me.git(dir, 'push', 'origin', 'main');
    assert.notEqual(push.code, 0, 'a same-line push landed');
    assert.match(push.stderr, /conflict in README\.md/, push.stderr);
    const out = await me.j(['conflicts'], { cwd: dir });
    assert.equal(out.refused, true, JSON.stringify(out));
    assert.deepEqual(out.paths, ['README.md']);
    assert.match((await me.ok(['status'], { cwd: dir })).stdout, /last landing refused \(yoneda conflicts\)/);
    await me.gitOk(dir, 'reset', '-q', '--hard', 'origin/main');
    await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
  });
  await w.row('status --brief (a clone)', async () => {
    const ran = await me.ok(['status', '--brief'], { cwd: repo.dir });
    assert.match(ran.stdout, new RegExp(`^yoneda ${repo.id} at ${w.api} \\| main: 0 commit\\(s\\) not on the platform`), ran.stdout);
    await me.commit(repo.dir, { 'unpushed.txt': 'x\n' }, 'Not pushed');
    const out = await me.j(['status'], { cwd: repo.dir });
    assert.equal(out.unpushed, '1', JSON.stringify(out));
    await me.gitOk(repo.dir, 'reset', '-q', '--hard', 'origin/main');
    await me.refused(['status'], 1, /not inside a Git repository/, { cwd: '/' });
  });
}

async function rebaseRows(w, me) {
  const repo = await flowRepo(w, me, 'rebase');
  await w.row('rebase <branch>', async () => {
    const before = await branch(me, repo, 'behind', { 'behind.txt': 'behind\n' });
    const main = await me.commit(repo.dir, { 'main.txt': 'main moved\n' }, 'Main moved');
    await me.gitOk(repo.dir, 'push', '-q', 'origin', 'main');
    const out = await me.j(['rebase', 'behind', '--repo', repo.id]);
    assert.equal(out.replayed, 1);
    assert.equal(out.up_to_date, false);
    const head = (await repo.refs())['refs/heads/behind'];
    assert.equal(head, out.head);
    assert.notEqual(head, before, 'the branch did not move');
    const commit = await me.api.get(`/repos/${repo.id}/commits/${head}`);
    assert.deepEqual(commit.parents, [main], 'it is not on main');
    assert.equal((await me.j(['rebase', 'behind', '--repo', repo.id])).up_to_date, true, 'a second rebase replayed');
  });
  await w.row('rebase --onto', async () => {
    await me.gitOk(repo.dir, 'pull', '-q', 'origin', 'main');
    const stage = await branch(me, repo, 'stage', { 'stage.txt': 'stage\n' });
    await branch(me, repo, 'feature', { 'feature.txt': 'feature\n' });
    const out = await me.j(['rebase', 'feature', '--onto', 'stage', '--repo', repo.id]);
    assert.equal(out.onto, 'stage');
    assert.deepEqual((await me.api.get(`/repos/${repo.id}/commits/${out.head}`)).parents, [stage], 'it is not on the other branch');
  });
  await w.row('rebase a conflict: exit 2, the branch stays', async () => {
    const head = await branch(me, repo, 'clash', { 'README.md': 'clash\nline two\n' });
    await me.commit(repo.dir, { 'README.md': 'main wins\nline two\n' }, 'Main wins');
    await me.gitOk(repo.dir, 'push', '-q', 'origin', 'main');
    await me.refused(['rebase', 'clash', '--repo', repo.id], 2, /rebase refused, clash unchanged[\s\S]*conflicting: README\.md/);
    assert.equal((await repo.refs())['refs/heads/clash'], head, 'the branch moved');
  });
}

async function policyRows(w, me) {
  const repo = await flowRepo(w, me, 'policy');
  await w.row('policy show', async () => {
    assert.deepEqual((await me.j(['policy', 'show'], { cwd: repo.dir })).policy, { approvals: 0, required_checks: [] });
    assert.match((await me.ok(['policy', 'show', '--repo', repo.id])).stdout, /"approvals": 0/);
  });
  await w.row('policy set', async () => {
    await me.j(['policy', 'set', '{"approvals":1,"required_checks":[]}'], { cwd: repo.dir });
    assert.equal((await me.api.get(`/repos/${repo.id}`)).policy.approvals, 1, 'the policy did not change');
    await branch(me, repo, 'gated', { 'gated.txt': 'x\n' });
    const gated = await me.y(['land', '--branch', 'gated', '--repo', repo.id]);
    assert.notEqual(gated.code, 0, 'the new policy did not hold the landing');
    await me.refused(['policy', 'set', 'not json', '--repo', repo.id], 64, /not JSON/);
    await me.j(['policy', 'set', '{"approvals":0,"required_checks":[]}'], { cwd: repo.dir });
    return gated.stderr.split('\n')[0];
  });
}

export async function landRowsAll(w, me) {
  const repo = await landRows(w, me);
  await conflictRows(w, me, repo);
  await rebaseRows(w, me);
  await policyRows(w, me);
}
