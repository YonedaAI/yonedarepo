// Kit item 48: clone in each mode, sparse, the offline checkout and git-remote-yoneda. Files are
// compared with what was pushed; "lazy" and "sparse" are proved by the objects a clone does not
// hold, never by the exit code.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { short } from './cli-walk-kit.mjs';

const MAIN = 'refs/heads/main';
const MAIN_RS = 'fn main() {\n    helper();\n}\n\nfn helper() {\n    println!("Hello walker");\n}\n';
const MAIN_RS2 = MAIN_RS.replace('Hello walker', 'Hello walker, again');

/** Blobs a clone knows of but does not hold. */
const missing = async (person, dir) => (await person.gitOk(dir, 'rev-list', '--objects', '--all', '--missing=print')).split('\n').filter((l) => l.startsWith('?')).length;

/** A private repository with two commits on main, a branch, and a file in each top folder. */
export async function seedTree(w, me) {
  const name = w.name('tree');
  const made = await me.j(['repo', 'create', name]);
  w.repos.push({ id: made.id, name });
  const dir = me.path('tree');
  await me.gitOk(me.home, 'clone', '-q', `yoneda::${w.api}/${made.id}`, dir);
  const big = randomBytes(4096).toString('hex');
  const files = { 'README.md': 'Hello walker\nA second line\n', 'src/app/main.rs': MAIN_RS, 'src/lib/util.rs': 'pub fn util() -> u32 {\n    7\n}\n', 'docs/guide.md': '# Guide\n\nWalker notes.\n', 'data/big.txt': `${big}\n` };
  const a = await me.commit(dir, files, 'First commit');
  await me.gitOk(dir, 'push', '-q', 'origin', 'main');
  const refs = await me.api.get(`/repos/${made.id}/refs`);
  const b = await me.commit(dir, { 'src/app/main.rs': MAIN_RS2 }, 'Second commit');
  await me.gitOk(dir, 'push', '-q', 'origin', 'main');
  await me.gitOk(dir, 'checkout', '-q', '-b', 'topic');
  const t = await me.commit(dir, { 'docs/topic.md': 'Only on topic\n' }, 'Topic commit');
  await me.gitOk(dir, 'push', '-q', 'origin', 'topic');
  await me.gitOk(dir, 'checkout', '-q', 'main');
  const after = await me.api.get(`/repos/${made.id}/refs`);
  assert.equal(after.refs[MAIN], b, 'main is not the pushed commit');
  return { id: made.id, name, dir, files, a, b, t, version: { a: refs.version, b: after.version } };
}

/** By name, on a repository with nothing in it: what Git prints, and `yoneda` knows the clone. */
async function namedRows(w, me, work) {
  const name = w.name('named');
  const made = await me.j(['repo', 'create', name]);
  w.repos.push({ id: made.id, name });
  const address = `${w.ownerHandle}/${name}`;
  await w.row('clone <owner>/<name>, empty: Git\'s own lines, into ./<name>', async () => {
    const ran = await me.ok(['clone', address], { cwd: work });
    assert.match(ran.stdout, new RegExp(`^Cloning yoneda::${w.api}/${address}$`, 'm'), ran.stdout);
    assert.match(ran.stderr, new RegExp(`Cloning into '${name}'\\.\\.\\.`), ran.stderr);
    assert.match(ran.stderr, /cloned an empty repository/, ran.stderr);
    assert.ok(existsSync(join(work, name, '.git')), `not in ./${name}`);
    assert.ok(!existsSync(join(work, w.ownerHandle)), 'a folder for the owner');
    assert.match((await me.ok(['status'], { cwd: join(work, name) })).stdout, new RegExp(made.id), 'yoneda does not know this clone');
    await me.refused(['clone', name], 64, /<owner>\/<name>/, { cwd: work });
  });
  await w.row('repo remote add --override', async () => {
    const dir = await plainRepo(me);
    await me.refused(['repo', 'remote', 'add', 'origin', `${w.ownerHandle}/no-such-${name}`], 64, /not a repository you can read/, { cwd: dir });
    const added = await me.j(['repo', 'remote', 'add', 'origin', address], { cwd: dir });
    assert.equal(added.url, `yoneda::${w.api}/${address}`);
    assert.equal(await me.gitOk(dir, 'remote', 'get-url', 'origin'), added.url);
    await me.gitOk(dir, 'remote', 'set-url', 'origin', 'https://example.test/x.git');
    await me.refused(['repo', 'remote', 'add', 'origin', address], 64, /add --override/, { cwd: dir });
    assert.equal(await me.gitOk(dir, 'remote', 'get-url', 'origin'), 'https://example.test/x.git', 'it replaced a remote unasked');
    assert.equal((await me.j(['repo', 'remote', 'add', 'origin', '--override', address], { cwd: dir })).replaced, 'https://example.test/x.git');
    assert.equal(await me.gitOk(dir, 'remote', 'get-url', 'origin'), added.url);
    await me.gitOk(dir, 'remote', 'remove', 'origin');
  });
  await w.row('completion bash, zsh, fish, powershell', async () => {
    assert.match((await me.ok(['completion', 'bash'])).stdout, /complete -o default -F _yoneda yoneda/);
    assert.match((await me.ok(['completion', 'zsh'])).stdout, /compdef _yoneda yoneda/);
    assert.match((await me.ok(['completion', 'fish'])).stdout, /complete -c yoneda/);
    assert.match((await me.ok(['completion', 'powershell'])).stdout, /Register-ArgumentCompleter/);
    await me.refused(['completion', 'tcsh'], 64, /unknown shell/);
    const offered = await me.exec('/bin/bash', ['-c', 'eval "$(yoneda completion bash)"; COMP_WORDS=(yoneda repo r); COMP_CWORD=2; _yoneda; echo "${COMPREPLY[@]}"']);
    assert.equal(offered.stdout, 'remote', `bash offers: ${offered.stdout} ${offered.stderr}`);
  });
}

async function cloneRows(w, me, tree) {
  const work = me.path('clones');
  mkdirSync(work, { recursive: true });
  await namedRows(w, me, work);
  await w.row('clone <id> (lazy)', async () => {
    const out = await me.j(['clone', tree.id], { cwd: work });
    const dir = join(work, tree.name);
    assert.equal(out.method, 'lazy');
    assert.equal(out.repo, tree.id);
    assert.equal(await me.gitOk(dir, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
    assert.equal(await me.gitOk(dir, 'rev-parse', 'HEAD'), tree.b, 'HEAD is not main');
    assert.equal(readFileSync(join(dir, 'src/app/main.rs'), 'utf8'), MAIN_RS2);
    const held = await missing(me, dir);
    assert.ok(held > 0, 'a lazy clone holds every blob');
    await me.gitOk(dir, 'show', `${tree.a}:src/app/main.rs`);
    assert.ok((await missing(me, dir)) < held, 'reading an old file fetched nothing');
    return `${held} blobs left on the platform`;
  });
  await w.row('clone <id> [dir] --full', async () => {
    const out = await me.j(['clone', tree.id, 'full', '--full'], { cwd: work });
    assert.equal(out.method, 'full');
    const dir = join(work, 'full');
    assert.equal(await missing(me, dir), 0, 'a full clone left objects behind');
    await me.gitOk(dir, 'fsck', '--strict');
    assert.equal(readFileSync(join(dir, 'data/big.txt'), 'utf8'), tree.files['data/big.txt']);
    assert.equal(await me.gitOk(dir, 'rev-parse', 'origin/topic'), tree.t, 'the branch is missing');
  });
  await w.row('clone <id> [dir] --sparse <dir,...>', async () => {
    const out = await me.j(['clone', tree.id, 'sparse', '--sparse', 'src/app,docs'], { cwd: work });
    assert.equal(out.method, 'sparse');
    assert.deepEqual(out.scope, ['src/app', 'docs']);
    const dir = join(work, 'sparse');
    assert.deepEqual(readdirSync(dir).sort(), ['.git', 'README.md', 'docs', 'src']);
    assert.deepEqual(readdirSync(join(dir, 'src')), ['app'], 'a folder out of scope was checked out');
    assert.ok(!existsSync(join(dir, 'data')), 'data/ was checked out');
    assert.ok((await me.gitOk(dir, 'config', '--get-all', 'yoneda.scope')).includes('src/app'));
    assert.equal(await me.gitOk(dir, 'rev-parse', 'HEAD'), tree.b);
  });
  await w.row('sparse <dir>', async () => {
    const dir = join(work, 'sparse');
    const out = await me.j(['sparse', 'data'], { cwd: dir });
    assert.deepEqual(out.scope, ['data']);
    assert.ok(existsSync(join(dir, 'data/big.txt')), 'data/ did not arrive');
    assert.ok(!existsSync(join(dir, 'docs')), 'docs/ stayed');
    assert.equal(readFileSync(join(dir, 'data/big.txt'), 'utf8'), tree.files['data/big.txt']);
  });
  await w.row('sparse --add <dir>', async () => {
    const dir = join(work, 'sparse');
    const out = await me.j(['sparse', '--add', 'docs'], { cwd: dir });
    assert.deepEqual(out.scope, ['data', 'docs']);
    assert.ok(existsSync(join(dir, 'docs/guide.md')) && existsSync(join(dir, 'data/big.txt')), 'one of the two is gone');
    await me.refused(['sparse', 'x'], 64, /no yoneda:: remote/, { cwd: await plainRepo(me) });
  });
  await w.row('clone refuses a non-empty folder and two modes', async () => {
    await me.refused(['clone', tree.id, 'full'], 1, /already exists and is not empty/, { cwd: work });
    await me.refused(['clone', tree.id, '--full', '--offline'], 64, /one of --full, --sparse <dir,...> and --offline/);
    await me.refused(['clone', tree.id, '--sparse', ','], 64, /one of/);
    await me.refused(['clone'], 64, /repository id/);
  });
}

/** A Git repository with no yoneda remote. */
async function plainRepo(me) {
  const dir = me.path('plain-repo');
  if (!existsSync(dir)) {
    mkdirSync(dir);
    await me.gitOk(dir, 'init', '-q');
    await me.commit(dir, { 'a.txt': 'a\n' }, 'Plain');
  }
  return dir;
}

async function anonymousRows(w, me, repos) {
  await w.rowOf('clone --origin (no login, public repository)', repos.pub, 'repo create --public', async () => {
    const seed = me.path('pub-seed');
    await me.gitOk(me.home, 'clone', '-q', `yoneda::${w.api}/${repos.pub.id}`, seed);
    await me.commit(seed, { 'README.md': 'Public words\n' }, 'Public');
    await me.gitOk(seed, 'push', '-q', 'origin', 'main');
    const stranger = w.person('stranger');
    await stranger.refused(['clone', repos.pub.id], 64, /clone needs --origin/);
    const out = await stranger.j(['clone', repos.pub.id, 'copy', '--origin', w.api]);
    assert.equal(out.repo, repos.pub.id);
    assert.equal(readFileSync(stranger.path('copy', 'README.md'), 'utf8'), 'Public words\n');
  });
}

async function offlineRows(w, me, tree) {
  const name = w.name('offline');
  const made = await me.j(['repo', 'create', name]);
  w.repos.push({ id: made.id, name });
  const seed = me.path('offline-seed');
  await me.gitOk(me.home, 'clone', '-q', `yoneda::${w.api}/${made.id}`, seed);
  await me.commit(seed, { 'README.md': 'Offline\n', 'keep.txt': 'keep\n' }, 'Seed');
  await me.gitOk(seed, 'push', '-q', 'origin', 'main');
  const dir = me.path('offline');
  let branch;
  await w.row('clone --offline', async () => {
    const out = await me.j(['clone', made.id, dir, '--offline']);
    assert.equal(out.method, 'api_snapshot');
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'keep\n');
  });
  await w.row('status (offline checkout)', async () => {
    const ran = await me.ok(['status'], { cwd: dir });
    assert.match(ran.stdout, new RegExp(`^repo\\s+${made.id} at ${w.api}`, 'm'));
    assert.match(ran.stdout, /^pending 0 local commit/m);
    const out = await me.j(['status'], { cwd: dir });
    branch = out.offline_branch;
    assert.ok(branch, `no offline branch: ${JSON.stringify(out)}`);
  });
  await w.row('status --brief (offline checkout)', async () => {
    assert.match((await me.ok(['status', '--brief'], { cwd: dir })).stdout, /\(offline checkout\)/);
  });
  await w.row('sync', async () => {
    await me.commit(dir, { 'offline.txt': 'from the offline checkout\n' }, 'Offline work');
    const out = await me.j(['sync'], { cwd: dir });
    assert.equal(out.pushed, 1, `pushed ${out.pushed}`);
    const head = (await me.api.get(`/repos/${made.id}/refs`)).refs[`refs/heads/${out.offline_branch}`];
    assert.ok(head, 'the offline branch is not on the platform');
    assert.equal((await me.api.get(`/repos/${made.id}/commits/${head}`)).message?.trim(), 'Offline work');
  });
  await w.row('sync --land', async () => {
    const out = await me.j(['sync', '--land'], { cwd: dir });
    assert.ok(out.landing, `no landing: ${JSON.stringify(out)}`);
    await me.gitOk(seed, 'pull', '-q', 'origin', 'main');
    assert.equal(readFileSync(join(seed, 'offline.txt'), 'utf8'), 'from the offline checkout\n', 'main lacks the work');
  });
  await w.row('pull (offline checkout)', async () => {
    await me.commit(seed, { 'moved.txt': 'moved on main\n' }, 'Moved on');
    await me.gitOk(seed, 'push', '-q', 'origin', 'main');
    const out = await me.j(['pull'], { cwd: dir });
    assert.equal(out.outcome, 'fast_forwarded');
    assert.equal(readFileSync(join(dir, 'moved.txt'), 'utf8'), 'moved on main\n');
  });
  await w.row('pull rebases pending commits, refuses a dirty tree', async () => {
    await me.commit(seed, { 'moved2.txt': 'moved again\n' }, 'Moved again');
    await me.gitOk(seed, 'push', '-q', 'origin', 'main');
    await me.commit(dir, { 'pending.txt': 'pending\n' }, 'Pending');
    const out = await me.j(['pull'], { cwd: dir });
    assert.equal(out.rebased, 1, JSON.stringify(out));
    assert.ok(existsSync(join(dir, 'moved2.txt')) && existsSync(join(dir, 'pending.txt')), 'one side is missing');
    await me.exec('/bin/sh', ['-c', 'echo dirty >> keep.txt'], { cwd: dir });
    await me.refused(['pull'], 1, /commit or stash/, { cwd: dir });
    await me.gitOk(dir, 'checkout', '--', 'keep.txt');
  });
  await w.row('sync and pull outside an offline checkout', async () => {
    await me.refused(['sync', '--attempt', 'a'], 64, /unknown option --attempt/);
    const ran = await me.y(['sync'], { cwd: tree.dir });
    assert.notEqual(ran.code, 0, 'sync ran in a Git clone');
    assert.match(ran.stderr, /is not a yoneda checkout/, short(ran.stderr));
  });
}

async function helperRows(w, me, tree) {
  const work = me.path('helper');
  mkdirSync(work, { recursive: true });
  const same = async (dir) => {
    assert.equal(await me.gitOk(dir, 'rev-parse', 'HEAD'), tree.b, 'HEAD is not main');
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), tree.files['README.md']);
    await me.gitOk(dir, 'fsck');
  };
  await w.row('git clone yoneda::<origin>/<id>', async () => {
    await me.gitOk(work, 'clone', '-q', `yoneda::${w.api}/${tree.id}`, 'by-id');
    await same(join(work, 'by-id'));
  });
  await w.row('git clone yoneda::<origin>/<handle>/<name>', async () => {
    await me.gitOk(work, 'clone', '-q', `yoneda::${w.api}/${w.ownerHandle}/${tree.name}`, 'by-name');
    await same(join(work, 'by-name'));
  });
  await w.row('git clone yoneda://<host>/<id>', async () => {
    await me.gitOk(work, 'clone', '-q', `yoneda://${new URL(w.api).host}/${tree.id}`, 'by-scheme');
    await same(join(work, 'by-scheme'));
  });
  await w.row('git clone -c yoneda.lazy=false', async () => {
    await me.gitOk(work, 'clone', '-q', '-c', 'yoneda.lazy=false', `yoneda::${w.api}/${tree.id}`, 'not-lazy');
    assert.equal(await missing(me, join(work, 'not-lazy')), 0, 'it left objects behind');
  });
  await w.row('git push through the helper, fresh clone', async () => {
    const dir = join(work, 'by-id');
    const head = await me.commit(dir, { 'pushed.txt': 'through the helper\n' }, 'Through the helper');
    await me.gitOk(dir, 'push', '-q', 'origin', 'main');
    assert.equal((await me.api.get(`/repos/${tree.id}/refs`)).refs[MAIN], head);
    await me.gitOk(work, 'clone', '-q', `yoneda::${w.api}/${tree.id}`, 'fresh');
    assert.equal(readFileSync(join(work, 'fresh', 'pushed.txt'), 'utf8'), 'through the helper\n');
    tree.b2 = head;
  });
  await w.row('git push by <handle>/<name>, fetch, pull', async () => {
    const dir = join(work, 'by-name');
    await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
    const head = await me.commit(dir, { 'by-name.txt': 'by name\n' }, 'By name');
    await me.gitOk(dir, 'push', '-q', 'origin', 'main');
    assert.equal((await me.api.get(`/repos/${tree.id}/refs`)).refs[MAIN], head);
    await me.gitOk(join(work, 'fresh'), 'fetch', '-q', 'origin');
    assert.equal(await me.gitOk(join(work, 'fresh'), 'rev-parse', 'origin/main'), head, 'fetch did not bring it');
    await me.gitOk(join(work, 'fresh'), 'pull', '-q', 'origin', 'main');
    assert.equal(await me.gitOk(join(work, 'fresh'), 'rev-parse', 'HEAD'), head, 'pull did not bring it');
    tree.b3 = head;
  });
  await w.row('git push a tag through the helper', async () => {
    const dir = join(work, 'fresh');
    await me.gitOk(dir, 'tag', '-a', 'walk-tag', '-m', 'A tag');
    await me.gitOk(dir, 'push', '-q', 'origin', 'walk-tag');
    // A first read can miss it (measured: 2 of 10 reads, under 1 s), so this waits for the one bound.
    await w.soon(async () => (await me.api.get(`/repos/${tree.id}/refs`)).refs['refs/tags/walk-tag'], 'the tag on the platform');
    await w.soon(async () => /refs\/tags\/walk-tag/.test(await me.gitOk(dir, 'ls-remote', '--tags', 'origin')), 'the tag in ls-remote');
  });
  await w.row('git push --delete a branch through the helper', async () => {
    const dir = join(work, 'fresh');
    await me.gitOk(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/doomed');
    await w.soon(async () => /refs\/heads\/doomed/.test(await me.gitOk(dir, 'ls-remote', 'origin')), 'the branch in ls-remote');
    const gone = await me.git(dir, 'push', 'origin', '--delete', 'doomed');
    assert.equal(gone.code, 0, short(gone.stderr));
    assert.ok(!(await me.api.get(`/repos/${tree.id}/refs`)).refs['refs/heads/doomed'], 'the branch is still there');
    const main = await me.git(dir, 'push', 'origin', '--delete', 'main');
    assert.notEqual(main.code, 0, 'main was deleted');
    assert.match(main.stderr, /Protected branches/, short(main.stderr));
  });
  await w.row('git-remote-yoneda refuses a bad remote plainly', async () => {
    const ran = await me.git(work, 'clone', '-q', 'yoneda::not-a-url', 'bad');
    assert.notEqual(ran.code, 0, 'it cloned');
    assert.match(ran.stderr, /is not a yoneda remote/, short(ran.stderr));
  });
}

export async function cloneRowsAll(w, me, repos) {
  const tree = await seedTree(w, me);
  await cloneRows(w, me, tree);
  await anonymousRows(w, me, repos);
  await helperRows(w, me, tree);
  await offlineRows(w, me, tree);
  return tree;
}
