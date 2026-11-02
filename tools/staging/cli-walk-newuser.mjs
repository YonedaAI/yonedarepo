// Kit item 48, a brand-new user: the real installer into an empty HOME, then what the empty
// repository's page shows, followed exactly. The owner's account stands in for theirs, signed in
// with what the /device page ticks by default.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_SCOPES, short } from './cli-walk-kit.mjs';
import { withChrome } from './kit-chrome.mjs';

const CLI_COMMANDS_NEWER_THAN_ANY_RELEASE = ['change route', 'flight-plan', 'search <query> --all', '--agent <name>'];

/** Reads the empty repository's page: what it says, and its Clone panel's lines. */
async function emptyPage(w, chrome, repo, m) {
  return withChrome({ ...chrome, name: 'cli-walk-empty' }, m, async ({ page, shot }) => {
    await page.goto(`${w.origin}/${w.ownerHandle}/${repo.name}`);
    await page.getByRole('heading', { name: 'main has no commits yet' }).waitFor();
    const says = await page.getByText('Push a first commit to see your code here.').innerText();
    await shot('empty-repository');
    await page.locator('.clone-menu > summary').click();
    await page.locator('.clone-menu').getByText('git clone ssh:').first().waitFor();
    await shot('empty-repository-clone');
    const lines = [...new Set(await page.locator('.clone-menu code, .clone-menu pre').allInnerTexts())];
    const text = await page.locator('.clone-menu').innerText();
    const steps = await page.locator('.repo-first-steps code').allInnerTexts();
    return { says, lines, text, steps };
  });
}

const line = (lines, pattern) => {
  const found = lines.find((l) => pattern.test(l));
  assert.ok(found, `the panel shows no line like ${pattern}: ${short(lines.join(' | '))}`);
  return found;
};

/** A stock-Git environment whose credential is the token, in the environment only. */
const httpsEnv = (person) =>
  person.env({
    GIT_ASKPASS: person.path('bin', 'askpass'),
    GIT_USERNAME_IS_ANYTHING: '1',
    WALK_TOKEN: person.token,
  });

/** Runs the clone line as the page shows it, as a person pastes it in a shell. */
const pasted = (person, text, cwd, env) => person.exec('/bin/sh', ['-c', text], { cwd, env });

async function installRows(w, person, m) {
  await w.row('install: curl .../install.sh | sh', async () => {
    // A machine with nothing on it: a cloudflared on PATH is one the installer leaves alone.
    const ran = await person.exec('/bin/sh', ['-c', `curl -fsSL ${w.origin}/install.sh | sh`], { env: person.env({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }) });
    assert.equal(ran.code, 0, `the installer exited ${ran.code}: ${short(ran.stderr || ran.stdout)}`);
    const dir = person.path('.local', 'bin');
    for (const tool of ['yoneda', 'git-remote-yoneda', 'cloudflared']) assert.ok(existsSync(join(dir, tool)), `no ${tool} in ${dir}`);
    assert.match(ran.stdout, /Installed yoneda/);
    assert.match(ran.stdout, /PATH set in .*\.profile/, 'the installer did not put the folder on PATH');
    assert.match(ran.stdout.trim().split('\n').at(-1), /^Next: yoneda login/, 'the last line is not the next step');
    person.bin = dir;
    w.extraPath.push(dir);
    m.installed = ran.stdout.split('\n')[0].replace(w.dir, '');
  });
  await w.rowOf('install: the release has this source\'s commands', person.bin !== w.bin, 'The install', async () => {
    const help = (await person.ok(['help'])).stdout;
    const missing = CLI_COMMANDS_NEWER_THAN_ANY_RELEASE.filter((word) => !help.includes(word));
    assert.deepEqual(missing, [], `the release the installer serves lacks: ${missing.join(', ')}`);
  });
}

async function loginRow(w, person) {
  await w.row('new user: login with the page\'s ticked scopes', async () => {
    await person.login({ scopes: DEVICE_SCOPES });
    await person.ok(['repo', 'list']);
  });
  await w.row('new user: repo create after a default login', async () => {
    const name = w.name('new-user-cli');
    const made = await person.y(['repo', 'create', name]);
    if (made.code === 0) w.repos.push({ id: made.stdout.match(/\((r[0-9a-f]{20})\)/)?.[1], name });
    assert.equal(made.code, 0, `a brand-new login cannot create a repository: ${short(made.stderr)}`);
  });
}

async function cloneSpellings(w, person, repo) {
  const work = person.path('spellings');
  await person.exec('/bin/mkdir', ['-p', work]);
  await w.row('Q2: yoneda clone <owner>/<name>', async () => {
    const ran = await person.y(['clone', `${w.ownerHandle}/${repo.name}`], { cwd: work });
    assert.equal(ran.code, 0, short(ran.stderr));
    assert.ok(existsSync(join(work, w.ownerHandle, repo.name, '.git')), 'not where it said');
    assert.ok(existsSync(join(work, repo.name, '.git')), `it landed in ${w.ownerHandle}/${repo.name}, not ./${repo.name}, where git clone puts it`);
  });
  await w.row('Q2: inside a clone by <owner>/<name>, yoneda knows the repository', async () => {
    const dir = join(work, w.ownerHandle, repo.name);
    assert.equal((await person.git(dir, 'remote', 'get-url', 'origin')).code, 0, 'no such clone');
    for (const args of [['status'], ['log'], ['change', 'list'], ['policy', 'show']]) {
      const ran = await person.y(args, { cwd: dir });
      assert.equal(ran.code, 0, `yoneda ${args.join(' ')} in the clone: ${short(ran.stderr)}`);
    }
  });
  await w.row('Q2: yoneda clone <id> (folder name)', async () => {
    const ran = await person.y(['clone', repo.id], { cwd: work });
    assert.equal(ran.code, 0, short(ran.stderr));
    assert.ok(existsSync(join(work, repo.name, '.git')) || !existsSync(join(work, repo.id)), `the folder is the id ${repo.id}, not the name ${repo.name}`);
  });
  await w.row('Q2: yoneda clone <name> says what to type', async () => {
    const ran = await person.y(['clone', repo.name], { cwd: work });
    assert.notEqual(ran.code, 0, 'a bare name cloned');
    assert.doesNotMatch(ran.stderr, /git clone -q|remote helper/, `the refusal is Git's plumbing: ${short(ran.stderr)}`);
  });
}

/** Q3: a project with history, pointed at a new repository with Git's own commands. */
async function existingProject(w, person, repo) {
  const dir = person.path('existing-project');
  await person.exec('/bin/mkdir', ['-p', dir]);
  await w.row('Q3: yoneda repo remote add origin <owner>/<name>, git push', async () => {
    await person.gitOk(dir, 'init', '-q');
    const head = await person.commit(dir, { 'app.txt': 'an existing project\n' }, 'Existing project');
    await person.ok(['repo', 'remote', 'add', 'origin', `${w.ownerHandle}/${repo.name}`], { cwd: dir });
    const pushed = await person.git(dir, 'push', '-u', 'origin', 'main');
    assert.equal(pushed.code, 0, short(pushed.stderr));
    const refs = await person.api.get(`/repos/${repo.id}/refs`);
    assert.equal(refs.refs['refs/heads/main'], head, 'main is not the project\'s commit');
    assert.match((await person.ok(['status'], { cwd: dir })).stdout, /main: 0 commit\(s\) not on the platform/);
    await person.commit(dir, { 'more.txt': 'more\n' }, 'More work');
    await person.gitOk(dir, 'push', '-q');
  });
}

/** A repository as the web's New repository dialog makes it: a README, and one approval. */
async function webRepo(w, what) {
  const name = w.name(what);
  const files = [{ path: 'README.md', content_b64: Buffer.from(`# ${name}\n`).toString('base64') }];
  const made = await w.owner.post('/repos', { name, visibility: 'private', policy: { required_checks: [], approvals: 1 }, files, author: { name: 'Repository owner', email: 'owner@yonedarepo.invalid' } });
  w.repos.push({ id: made.id, name });
  return { id: made.id, name };
}

/** The other way in: New repository on the web, then the first push from a clone or a project. */
async function webCreatedRows(w, person) {
  const repo = await webRepo(w, 'web');
  const dir = person.path('web-clone');
  await w.row('new user: push to a repository from the web, alone', async () => {
    await person.gitOk(person.home, 'clone', '-q', `yoneda::${w.api}/${repo.id}`, dir);
    await person.commit(dir, { 'README.md': `# ${repo.name}\n\nMore.\n` }, 'Edit');
    const pushed = await person.git(dir, 'push', 'origin', 'main');
    assert.doesNotMatch(pushed.stderr, /\{"approvals"/, `the refusal is raw JSON: ${short(pushed.stderr)}`);
    assert.equal(pushed.code, 0, short(pushed.stderr));
  });
  await w.row('Q3: a project with history into a repository from the web', async () => {
    const project = person.path('web-project');
    await person.gitOk(person.home, 'init', '-q', 'web-project');
    await person.commit(project, { 'app.txt': 'an existing project\n' }, 'Existing project');
    await person.gitOk(project, 'remote', 'add', 'origin', `yoneda::${w.api}/${repo.id}`);
    await person.gitOk(project, 'pull', '-q', '--no-rebase', '--no-edit', '--allow-unrelated-histories', 'origin', 'main');
    // The merge holds main, so the one thing to say about it is that it still needs its approval.
    const pushed = await person.git(project, 'push', '-u', 'origin', 'main');
    assert.doesNotMatch(pushed.stderr, /shares no commit/, `the merged project, which holds main, is refused: ${short(pushed.stderr)}`);
  });
}

/** Q4: every line of the Clone panel, in a fresh folder, then a commit and a push from it. */
async function followThePage(w, person, repos, page) {
  const work = person.path('from-the-page');
  await person.exec('/bin/mkdir', ['-p', work]);
  await w.row('Q4: the page says how to start', async () => {
    assert.match(page.says, /Push a first commit/);
    assert.match(page.text, /yoneda login --origin/);
    const [install, clone, upstream] = page.steps;
    assert.match(install ?? '', /install\.sh/, 'the page never says how to get `yoneda` or git-remote-yoneda: `git clone yoneda::` fails without it');
    assert.equal(clone, `yoneda clone ${w.ownerHandle}/${repos.page.name}`);
    assert.equal(upstream, `yoneda repo remote add origin ${w.ownerHandle}/${repos.page.name}`);
  });
  await w.row('Q4: the page\'s helper clone line, commit, push', async () => {
    const shown = line(page.lines, /^git clone yoneda::/);
    const ran = await pasted(person, shown, work);
    assert.equal(ran.code, 0, short(ran.stderr));
    const dir = join(work, repos.page.name);
    const head = await person.commit(dir, { 'README.md': `# ${repos.page.name}\n` }, 'First commit');
    const pushed = await person.git(dir, 'push', 'origin', 'main');
    assert.equal(pushed.code, 0, short(pushed.stderr));
    assert.equal((await person.api.get(`/repos/${repos.page.id}/refs`)).refs['refs/heads/main'], head);
    assert.equal(await person.gitOk(dir, 'rev-parse', 'origin/main'), head, 'the tracking ref did not move');
  });
  await w.row('Q4: the page\'s HTTPS clone line with a token as the password', async () => {
    const url = line(page.lines, /^git clone https:/).split(' ')[2];
    assert.match(url, new RegExp(`/${w.ownerHandle}/${repos.page.name}\\.git$`), `the URL is ${url}`);
    const ran = await pasted(person, `git clone ${url} https-copy`, work, httpsEnv(person));
    assert.equal(ran.code, 0, short(ran.stderr));
    assert.ok(readFileSync(join(work, 'https-copy', 'README.md'), 'utf8').startsWith('# '), 'the clone is empty');
  });
  await w.row('Q4: the page\'s SSH clone line after yoneda ssh setup', async () => {
    const setup = await person.j(['ssh', 'setup']);
    w.keys.push(setup.fingerprint);
    assert.equal(setup.check_passed, true, `ssh -T did not pass: ${setup.check_output}`);
    const shown = line(page.lines, /^git clone ssh:/);
    const ran = await pasted(person, `${shown} `.replace(/ \S+ $/, ' ssh-copy'), work);
    assert.equal(ran.code, 0, short(ran.stderr));
    assert.ok(existsSync(join(work, 'ssh-copy', 'README.md')), 'the SSH clone is empty');
  });
}

/** What a person sees with `git clone yoneda::` and no git-remote-yoneda. */
async function noHelper(w, person, repo) {
  await w.row('Q4: without the helper installed, git says something useful', async () => {
    const bare = w.person('no-cli', '/nonexistent');
    bare.bin = '/nonexistent';
    const paths = bare.env().PATH.split(':').filter((p) => !p.startsWith(person.path()));
    const ran = await bare.exec('git', ['clone', `yoneda::${w.api}/${repo.id}`, 'copy'], { env: bare.env({ PATH: paths.join(':') }) });
    assert.notEqual(ran.code, 0, 'it cloned');
    assert.match(ran.stderr, /remote-yoneda|remote helper/, short(ran.stderr));
    return ran.stderr.split('\n')[0];
  });
}

export async function newUserRows(w, { chrome, m }) {
  const person = w.person('newcomer');
  await person.exec('/bin/sh', ['-c', `printf '#!/bin/sh\\ncase "$1" in Username*) echo token;; *) printf %%s "$WALK_TOKEN";; esac\\n' > bin/askpass; chmod +x bin/askpass`]);
  await installRows(w, person, m);
  await loginRow(w, person);
  const empty = async (what) => {
    const name = w.name(what);
    const made = await w.ownerCli.j(['repo', 'create', name]);
    w.repos.push({ id: made.id, name });
    return { id: made.id, name };
  };
  const repos = { spell: await empty('spell'), existing: await empty('existing'), page: await empty('page') };
  await cloneSpellings(w, person, repos.spell);
  await existingProject(w, person, repos.existing);
  await webCreatedRows(w, person);
  let page;
  await w.row('Q4: the empty repository page', async () => {
    page = await emptyPage(w, chrome, repos.page, m);
    m.empty_page = [page.says, ...page.lines];
    return page.lines.join(' | ');
  });
  await followThePage(w, person, repos, page ?? { lines: [], text: '', says: '' });
  await noHelper(w, person, repos.page);
}
