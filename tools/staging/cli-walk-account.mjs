// Kit item 48: help, sign-in and the account's repositories. Every row reads its outcome back: over
// the API, from the anonymous side, or from the files the command wrote in the throwaway HOME.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_SCOPES, writeFile } from './cli-walk-kit.mjs';

const mode = (path) => (statSync(path).mode & 0o777).toString(8);

async function helpRows(w, me) {
  await w.row('help, --help, -h, no arguments', async () => {
    const help = await me.ok(['help']);
    assert.match(help.stdout, /^usage: yoneda <command>/);
    for (const args of [['--help'], ['-h'], []]) assert.equal((await me.ok(args)).stdout, help.stdout, `yoneda ${args.join(' ')}`);
  });
  await w.row('unknown command, unknown option', async () => {
    for (const [args, said] of [[['frobnicate'], /^yoneda: unknown command "frobnicate"/], [['repo', 'list', '--nope'], /^yoneda: unknown option --nope/]]) {
      const ran = await me.refused(args, 64, said);
      assert.deepEqual(ran.stderr.split('\n').slice(1), ['Run `yoneda help` to see the commands.'], 'not one line and a hint');
    }
  });
  await w.row('version, --version, -V', async () => {
    const version = (await me.ok(['version'])).stdout;
    assert.match(version, /^yoneda \d+\.\d+\.\d+$/);
    for (const flag of ['--version', '-V']) assert.equal((await me.ok([flag])).stdout, version, flag);
  });
}

async function loginRows(w, me, other) {
  await w.row('login (opens the browser)', async () => {
    const { done, token } = await me.login({ args: [] });
    assert.match(done.stdout, /Logged in to .* as /);
    const opened = readFileSync(me.path('opened-urls'), 'utf8').trim();
    assert.match(opened, new RegExp(`^${w.origin}/device`), `the browser was sent to ${opened}`);
    assert.equal(mode(me.credentialsFile()), '600', 'the stored token is not 0600');
    assert.equal(me.remember().origin, w.api, 'the token is stored for another origin');
    assert.ok(token.host, 'the token does not say which machine signed in');
    return `${(await me.j(['repo', 'list'])).repos.length} repositories visible`;
  });
  await w.row('login --no-browser --origin', async () => {
    await other.login({ scopes: ALL_SCOPES });
    assert.ok(!existsSync(other.path('opened-urls')), '--no-browser opened the browser');
  });
  await w.rowOf('login --with-token', me.token, 'A login', async () => {
    const third = w.person('with-token');
    const ran = await third.j(['login', '--with-token', '--origin', w.api], { input: `${me.token}\n` });
    assert.doesNotMatch(JSON.stringify(ran), /\[secret\]/, 'the token was printed');
    third.remember();
    assert.equal(third.token, me.token, 'another token was stored');
    await third.ok(['repo', 'list']);
    await third.refused(['login', '--with-token', '--origin', w.api], 1, /empty/, { input: '' });
  });
  await w.notRun('auth token', 'The kit never prints a credential. Unit-tested in auth_token.rs.');
  await w.notRun('auth token --show', 'The kit never prints a credential. Unit-tested in auth_token.rs.');
}

/** Signs one agent up on `repo`, reads as it, and signs it out, which logs it out here too. */
async function agentRows(w, me, repo) {
  const name = `walk-${String(w.ts).slice(-8)}`;
  const agent = { YONEDA_AGENT: name };
  await w.row('login --agent', async () => {
    const slot = me.path('.config', 'yoneda', 'agents', name, 'credentials');
    const done = await me.device(['--agent', name, '--no-browser'], { scopes: ['repo:read', 'repo:write'], repos: [repo.id] });
    assert.match(done.stdout, new RegExp(`as agent ${name} of `), done.stdout);
    assert.equal(mode(slot), '600', "the agent's token is not 0600");
    const { token } = JSON.parse(readFileSync(slot, 'utf8'));
    w.secrets.add(token);
    const log = await me.y(['log', '--repo', repo.id], { env: me.env(agent) });
    assert.equal(log.code, 0, `the agent cannot read its repository: ${log.stderr}`);
    const refused = await me.y(['repo', 'create', w.name('agent-refused')], { env: me.env(agent) });
    assert.notEqual(refused.code, 0, 'an agent created a repository');
  });
  await w.row('logout --agent', async () => {
    const out = await me.j(['logout', '--agent', name]);
    assert.equal(out.removed, true, 'nothing was removed');
    assert.ok(existsSync(me.credentialsFile()), "the person's login went too");
    const none = await me.y(['log', '--repo', repo.id], { env: me.env(agent) });
    assert.notEqual(none.code, 0, 'the logged-out agent borrowed the login');
  });
  const { tokens } = await w.owner.get('/tokens');
  for (const token of tokens.filter((t) => t.origin === `agent:${name}` || t.origin?.startsWith(`agent:${name}`))) await w.owner.call('DELETE', `/tokens/${token.id}`);
}

async function logoutRows(w, other) {
  await w.row('logout --origin (another platform)', async () => {
    const out = await other.j(['logout', '--origin', 'https://other.example.test']);
    assert.equal(out.removed, false, 'it removed a token of another platform');
    assert.ok(existsSync(other.credentialsFile()), 'the token is gone');
  });
  await w.row('logout', async () => {
    const out = await other.j(['logout']);
    assert.equal(out.removed, true, 'nothing was removed');
    assert.equal(out.revoked, true, 'the token was not revoked');
    assert.ok(!existsSync(other.credentialsFile()), 'the credentials file is still there');
    w.tokens = w.tokens.filter((t) => t.id !== other.patId);
    await other.refused(['repo', 'list', '--origin', w.api], 1, /login/i);
    assert.equal((await other.j(['logout'])).removed, false, 'a second logout removed something');
    await w.soon(async () => (await other.api.raw('GET', '/repos')).status === 401, 'the token to stop working');
  });
}

/** The repository's visibility seen from outside: its status, for no credentials at all. */
const anonymousStatus = async (w, id) => (await w.anonymous().raw('GET', `/repos/${id}`)).status;

async function createRows(w, me, repos) {
  await w.row('repo create <name>', async () => {
    const name = w.name('private');
    const made = await me.j(['repo', 'create', name]);
    w.repos.push({ id: made.id, name });
    repos.plain = { id: made.id, name };
    assert.equal(made.remote, `yoneda::${w.api}/${made.id}`);
    const status = await me.api.get(`/repos/${made.id}`);
    assert.equal(status.name, name);
    assert.equal(status.visibility ?? 'private', 'private');
    assert.deepEqual(status.policy, { approvals: 0, required_checks: [] }, `policy ${JSON.stringify(status.policy)}`);
    assert.equal(await anonymousStatus(w, made.id), 404, 'a private repository answers strangers');
  });
  await w.row('repo create --public', async () => {
    const name = w.name('public');
    const made = await me.ok(['repo', 'create', name, '--public']);
    const id = made.stdout.match(/\((r[0-9a-f]{20})\)/)?.[1];
    assert.ok(id, `no id in: ${made.stdout}`);
    assert.match(made.stdout, new RegExp(`^Created public ${name}`));
    assert.match(made.stdout, new RegExp(`git clone yoneda::${w.api}/${id}`));
    w.repos.push({ id, name });
    repos.pub = { id, name };
    assert.equal(await anonymousStatus(w, id), 200, 'a public repository refused strangers');
  });
  await w.rowOf('repo list', repos.plain && repos.pub, 'repo create', async () => {
    const { repos: listed } = await me.j(['repo', 'list']);
    const seen = Object.fromEntries(listed.map((r) => [r.id, r.visibility]));
    assert.equal(seen[repos.plain.id], 'private');
    assert.equal(seen[repos.pub.id], 'public');
    const human = await me.ok(['repo', 'list']);
    assert.match(human.stdout, new RegExp(`^${repos.pub.id}  ${repos.pub.name}  public`, 'm'));
  });
  await w.rowOf('repo visibility <id> public|private', repos.plain, 'repo create', async () => {
    const { id } = repos.plain;
    assert.equal((await me.j(['repo', 'visibility', id, 'public'])).visibility, 'public');
    await w.soon(async () => (await anonymousStatus(w, id)) === 200, 'the anonymous read');
    assert.equal((await me.j(['repo', 'visibility', id, 'private'])).visibility, 'private');
    await w.soon(async () => (await anonymousStatus(w, id)) === 404, 'the anonymous refusal');
    await me.refused(['repo', 'visibility', 'nonsense', 'public'], 64, /is not a repository id/);
    await me.refused(['repo', 'visibility', id, 'internal'], 64, /public\|private/);
  });
}

async function importRows(w, me, repos) {
  const project = me.path('import-me');
  const files = { 'README.md': '# Imported\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'run.sh': '#!/bin/sh\n' };
  await w.row('repo import <dir> --name --batch-files', async () => {
    for (const [path, text] of Object.entries(files)) writeFile(join(project, path), text);
    execFileSync('chmod', ['+x', join(project, 'run.sh')]);
    await me.gitOk(project, 'init', '-q');
    await me.commit(project, { 'ignored.tmp': 'x\n' }, 'one');
    await me.gitOk(project, 'rm', '-q', 'ignored.tmp');
    await me.gitOk(project, 'commit', '-q', '-m', 'two');
    const name = w.name('import');
    const made = await me.j(['repo', 'import', project, '--name', name, '--batch-files', '2']);
    w.repos.push({ id: made.id, name });
    repos.imported = { id: made.id, name };
    assert.equal(made.files, 4, `imported ${made.files} files`);
    const copy = me.path('import-copy');
    await me.ok(['clone', made.id, copy, '--full']);
    for (const [path, text] of Object.entries(files)) assert.equal(readFileSync(join(copy, path), 'utf8'), text, path);
    assert.ok(!existsSync(join(copy, 'ignored.tmp')), 'a file not at HEAD was imported');
    assert.equal(mode(join(copy, 'run.sh')).slice(0, 1), '7', 'the executable bit was lost');
  });
  await w.row('repo import <dir> (a plain folder, its name)', async () => {
    const dir = me.path(w.name('plain-folder'));
    writeFile(join(dir, 'only.txt'), 'plain\n');
    writeFile(join(dir, 'nested/two.txt'), 'two\n');
    const made = await me.j(['repo', 'import', dir]);
    w.repos.push({ id: made.id, name: made.name });
    assert.equal(made.name, w.name('plain-folder'), 'the folder did not name it');
    const bytes = await me.api.get(`/repos/${made.id}/tree?ref=main`).catch(() => null);
    const log = await me.ok(['grep', 'plain', '--repo', made.id]);
    assert.match(log.stdout, /^only\.txt:1: plain$/m, `${log.stdout} ${JSON.stringify(bytes)?.slice(0, 80)}`);
    await me.refused(['repo', 'import', dir, '--batch-files', '0'], 64, /at least 1/);
  });
}

async function forkRows(w, me, repos) {
  await w.rowOf('repo fork <id> --name', repos.imported, 'repo import', async () => {
    const name = w.name('fork');
    const fork = await me.j(['repo', 'fork', repos.imported.id, '--name', name]);
    w.repos.unshift({ id: fork.id, name });
    repos.fork = { id: fork.id, name };
    assert.equal(fork.name, name);
    const copy = me.path('fork-copy');
    await me.ok(['clone', fork.id, copy]);
    assert.equal(readFileSync(join(copy, 'README.md'), 'utf8'), '# Imported\n', 'the fork lacks the parent\'s files');
    const status = await me.api.get(`/repos/${fork.id}`);
    assert.equal(status.parent?.repo, repos.imported.id, 'the fork does not name its parent');
    await me.refused(['repo', 'fork', 'nonsense'], 64, /is not a repository id/);
  });
  await w.rowOf('change create --to-parent', repos.fork, 'repo fork', async () => {
    const copy = me.path('fork-copy');
    await me.gitOk(copy, 'checkout', '-q', '-b', 'from-fork');
    await me.commit(copy, { 'fork.txt': 'from the fork\n' }, 'Work on the fork');
    await me.gitOk(copy, 'push', '-q', 'origin', 'from-fork');
    const opened = await me.j(['change', 'create', 'from-fork', '--to-parent', '--title', 'From the fork'], { cwd: copy });
    assert.equal(opened.repo, repos.imported.id, 'it opened elsewhere');
    const change = await me.api.get(`/repos/${repos.imported.id}/changes/${opened.change.number}`);
    assert.equal(change.source_repo, repos.fork.id, 'the change does not name the fork');
    assert.equal(change.title, 'From the fork');
    await me.refused(['change', 'create', 'from-fork', '--to-parent', '--repo', repos.imported.id], 64, /is not a fork/, { cwd: me.home });
  });
}

/** Help and sign-in; then repositories. Returns the people and repositories later rows use. */
export async function accountRows(w) {
  const me = w.person('me');
  const other = w.person('other');
  const repos = {};
  await helpRows(w, me);
  await loginRows(w, me, other);
  await logoutRows(w, other);
  await createRows(w, me, repos);
  await importRows(w, me, repos);
  await forkRows(w, me, repos);
  if (repos.plain) await agentRows(w, me, repos.plain);
  else for (const id of ['login --agent', 'logout --agent']) w.results.set(id, { status: 'fail', ms: 0, note: 'repo create did not get made' });
  return { me, repos };
}
