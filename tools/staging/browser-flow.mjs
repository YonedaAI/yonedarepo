// Browser gate (kit item `browser`): headless system Chrome (playwright-core, channel `chrome`)
// drives the served app as a person does, with zero model spend. It signs the kit account in
// through the real login form, creates a repository with the shell's "New repository" dialog,
// opens its Code tab and Clone menu (the SSH line exactly when Git over SSH is open), History
// (where it creates a branch under "Branches and tags" and deletes it again),
// Changes (the empty list) and Settings (Landing rules, Connect) tabs
// and the account Settings page. Then the second kit account (a member at write) commits on a
// branch by API, the kit account opens a change for it and approves and lands it in the Change
// page (the platform refuses an author's own approval); the page and the API must both read it
// back landed. A second branch, cut from main before that landing, is then behind main: its
// Change page's "Rebase on main" replays it onto main. The Agents tab then shows a session
// recorded by API (browser-agent-flow.mjs). Releases, forks and organizations follow
// (browser-collab-flow.mjs), then tokens, deleting an org and a repository deleted while its
// page is open (browser-admin-flow.mjs). Each step's screenshot goes to .local/staging/browser-<ts>/; a
// failure adds the page text and console errors there. The API (with the browser's own session
// cookie) is used only to set up the change, read back and clean up.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { adminPages, deletedRepoPage } from './browser-admin-flow.mjs';
import { agentPages } from './browser-agent-flow.mjs';
import { managedAgentPages } from './browser-managed-agents-flow.mjs';
import { forkPages, orgPages, releasePages } from './browser-collab-flow.mjs';
import { b64, Session, secondAccount, sleep, until } from './client.mjs';
import { atRepo, openRepo, repoPath } from './repo-urls.mjs';

const author = { name: 'Browser gate', email: 'kit@yonedarepo.invalid' };

/** A Cookie header from Playwright cookies. */
export const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** Removes every secret from captured text before it is written to evidence. */
export function scrub(text, secrets) {
  return secrets.filter((s) => s && s.length >= 4).reduce((out, s) => out.split(s).join('[redacted]'), String(text));
}

/**
 * Polls until `ok` is visible (returns) or any `failures` locator is (throws with its text).
 * Failures are alerts the app renders, so the gate stops at once instead of timing out.
 */
export async function settle(ok, failures, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ok.isVisible().catch(() => false)) return;
    for (const failure of failures) {
      const shown = failure.first();
      if (await shown.isVisible().catch(() => false)) throw new Error(`${what}: ${(await shown.innerText()).slice(0, 300)}`);
    }
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await sleep(1000);
  }
}

export async function browserFlow({ origin, api, kit, root, headed = false }, m) {
  const dir = join(root, `.local/staging/browser-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  m.evidence = relative(root, dir);
  const secrets = [kit.KIT_PASSWORD];
  const problems = [];
  const cleanup = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', async (response) => {
    if (response.status() < 400) return;
    const body = await response.json().catch(() => ({}));
    problems.push(`http ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname} ${body.error?.code ?? ''} ${(body.error?.message ?? '').slice(0, 200)}`);
  });
  let shots = 0;
  const shot = (name) => page.screenshot({ path: join(dir, `${String(++shots).padStart(2, '0')}-${name}.png`), fullPage: true });
  try {
    await publicHome(page, origin, shot, m);
    await signIn(page, origin, kit);
    await shot('signed-in');
    const account = new Session(origin, { cookie: cookieHeader(await context.cookies(origin)) });
    const repo = await sourcePages(page, origin, account, { api, shot, cleanup }, m);
    const landed = await changeLanded(page, { origin, kit, account, repo, shot }, m);
    await changeRebased(page, { origin, account, repo, shot, ...landed }, m);
    await agentPages(page, { account, repo, shot }, m);
    await managedAgentPages(page, { repo, shot }, m);
    await releasePages(page, { account, repo, shot }, m);
    await forkPages(page, { account, repo, shot, cleanup }, m);
    await orgPages(page, { account, member: landed.member, shot, cleanup }, m);
    await adminPages(page, { api, account, repo, shot, cleanup, secrets }, m);
    await deletedRepoPage(page, { origin, account, shot, cleanup }, m);
  } catch (error) {
    await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true }).catch(() => {});
    const text = await page.locator('body').innerText().catch((e) => `page text unavailable: ${e.message}`);
    await writeFile(join(dir, 'failure.txt'), scrub(`${error.message}\n\nURL: ${page.url()}\n\n${text.slice(0, 20_000)}\n\n${problems.join('\n')}\n`, secrets));
    throw error;
  } finally {
    for (const undo of cleanup.reverse()) await undo().catch((e) => problems.push(`cleanup: ${e.message}`));
    await browser.close();
    if (problems.length) await writeFile(join(dir, 'console.txt'), scrub(`${problems.join('\n')}\n`, secrets));
    m.console_errors = problems.length;
  }
}

/** The public site's top nav, in order, as a signed-out visitor sees it at `/`. */
/** Features and Company open menus (buttons); the rest are links. */
export const PUBLIC_NAV = ['Features', 'Company', 'Pricing', 'Docs', 'Blog'];
/** Where the login form lives since `/` became the public home for signed-out visitors. */
export const signInUrl = (origin) => new URL('/signin', origin).href;

/** The signed-out home: one h1, the public nav, and a Sign in link that reaches the form. */
export async function publicHome(page, origin, shot, m) {
  await page.goto(origin);
  await page.getByRole('heading', { level: 1 }).waitFor();
  const nav = page.getByRole('navigation', { name: 'Main' });
  const links = await nav.getByRole('listitem').locator(':scope > a, :scope > button').allInnerTexts();
  assert.deepEqual(links.map((l) => l.trim()), PUBLIC_NAV, 'the public home nav');
  await shot('public-home');
  await nav.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(signInUrl(origin));
  await page.getByRole('navigation', { name: 'Account access' }).waitFor();
  m.public_home = 'nav and sign-in link';
}

/** The real login form at `/signin`; the kit password is typed only here. */
export async function signIn(page, origin, { KIT_USERNAME, KIT_LOGIN, KIT_PASSWORD }) {
  await page.goto(signInUrl(origin));
  await page.getByRole('navigation', { name: 'Account access' }).getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Username or email').fill(KIT_LOGIN ?? KIT_USERNAME);
  const password = page.getByLabel('Password', { exact: true });
  await password.fill(KIT_PASSWORD);
  await password.press('Enter');
  await settle(page.getByRole('button', { name: 'New repository' }).first(), [page.getByRole('alert')], { timeoutMs: 30_000, what: 'sign-in' });
}

/** A settings page: the account menu's Account item (its summary is labelled "Account: <name>"),
 * then the sidebar's Account group. */
export async function accountSettings(page, section = 'General') {
  const menu = page.locator('details.account-menu');
  await menu.getByLabel(/^Account:/).click();
  await menu.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('navigation', { name: 'Account', exact: true }).getByRole('link', { name: section, exact: true }).click();
  await page.getByRole('heading', { level: 1, name: section, exact: true }).waitFor();
}

/** "New repository" opens a dialog that creates a platform repository seeded with a README. */
export async function newRepository(page, name) {
  await page.getByRole('button', { name: 'New repository' }).first().click();
  await page.getByRole('menuitem', { name: 'Create repository' }).click();
  const dialog = page.getByRole('dialog', { name: 'New repository' });
  await dialog.getByLabel('Repository name').fill(name);
  await dialog.getByRole('button', { name: 'Create repository' }).click();
}

/** A platform repository: create it, open its tabs and the account settings; deleted by API at the end. */
export async function sourcePages(page, origin, account, { api, shot, cleanup }, m) {
  const name = `kit-browser-${Date.now()}`;
  await page.goto(origin);
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/repos' && r.request().method() === 'POST');
  await newRepository(page, name);
  const response = await created;
  assert.ok(response.ok(), `Create repository: HTTP ${response.status()}`);
  const { id } = await response.json();
  m.repo = id;
  cleanup.push(async () => {
    const done = await account.raw('DELETE', `/api/v1/repos/${id}?confirm=${encodeURIComponent(name)}`);
    assert.ok(done.ok, `Delete repository: ${done.status} ${done.body?.error?.code ?? ''}`);
    assert.equal((await account.raw('GET', `/api/v1/repos/${id}`)).status, 404, 'Deleted repository is still served');
    m.repo_deleted = true;
  });
  await page.getByRole('button', { name: `Switch repository (current: ${name})` }).waitFor();
  await atRepo(page, account, id);
  await page.getByRole('region', { name: 'Files' }).getByText('README.md').first().waitFor();
  await shot('source-code');
  // The Clone menu: the SSH line exactly when the platform says Git over SSH is open.
  const ssh = (await account.raw('GET', '/api/v1/ssh-keys')).body?.ssh;
  await page.locator('.clone-menu > summary').click();
  const cloneMenu = page.locator('.clone-dropdown');
  await cloneLines(page, cloneMenu, { api, id, name, path: await repoPath(account, id) }, 'the Clone menu');
  const sshBlock = cloneMenu.locator('.source-copy', { has: page.getByText('SSH', { exact: true }) });
  if (ssh?.front_door && ssh.host) {
    m.ssh_clone = await sshBlock.locator('code').innerText();
    assert.equal(m.ssh_clone, `git clone ssh://git@${ssh.host}/${id}.git ${name}`, 'the Clone menu SSH line');
    if (ssh.front_door === 'tunnel')
      await cloneMenu.getByRole('link', { name: 'Settings → SSH keys' }).waitFor();
  } else {
    await page.waitForTimeout(1000); // the SSH answer has arrived and showed nothing
    assert.equal(await sshBlock.count(), 0, 'an SSH clone line while SSH is off');
    m.ssh_clone = 'off (none shown)';
  }
  await shot('source-clone');
  await page.keyboard.press('Escape');
  const tabs = page.getByRole('navigation', { name: 'Repository' });
  await tabs.getByRole('link', { name: 'Commits' }).click();
  await page.getByRole('list', { name: 'History of main' }).getByRole('listitem').first().waitFor();
  await shot('source-history');
  await branchesPage(page, account, id, shot, m);
  await tabs.getByRole('link', { name: 'Changes' }).click();
  await atRepo(page, account, id, `/changes`);
  await page.getByText('No open changes.').waitFor();
  await shot('source-changes');
  await tabs.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Landing rules' }).waitFor();
  await shot('source-settings');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Connect' }).click();
  await page.getByRole('heading', { name: 'Clone with git' }).waitFor();
  // Git, the CLI and MCP live on the platform API host, never the app's own origin.
  m.clone_url = await cloneLines(page, page.locator('.source-connect'), { api, id, name, path: await repoPath(account, id) }, 'Connect');
  await shot('source-connect');
  await accountSettings(page, 'Tokens');
  await page.getByRole('heading', { name: 'Personal access tokens' }).waitFor();
  await shot('account-settings');
  m.source_pages = 'code,history,branches,changes,settings,connect,account-settings';
  return { id, name };
}

/**
 * The clone commands in `scope` (Clone menu or Connect): the recommended yoneda remote helper
 * first with its one-time `yoneda login` on the API origin, then HTTPS pointing at Settings →
 * Personal tokens; each a whole command into a directory named after the repository.
 */
export async function cloneLines(page, scope, { api, id, name, path }, what) {
  const blocks = scope.locator('.source-copy');
  await blocks.first().waitFor();
  const labels = await blocks.locator('.source-copy-head > span').allInnerTexts();
  assert.deepEqual(labels.slice(0, 2), ['yoneda remote helper (recommended)', 'HTTPS (needs a personal token as the password)'], `${what}: clone entries out of order`);
  assert.equal(await blocks.nth(0).locator('code').innerText(), `git clone yoneda::${api}/${id} ${name}`, `${what}: the yoneda line`);
  const https = await blocks.nth(1).locator('code').innerText();
  assert.equal(https, `git clone ${api}${path}.git ${name}`, `${what}: the HTTPS line`);
  await scope.getByText(`yoneda login --origin ${api}`, { exact: true }).first().waitFor();
  assert.equal(await scope.getByRole('link', { name: 'Settings → Personal tokens' }).getAttribute('href'), '/settings/tokens', `${what}: the personal token link`);
  return https;
}

/** History → "Branches and tags": create a branch from main in the page, then delete it; the
 * API reads back both. */
export async function branchesPage(page, account, id, shot, m) {
  const name = 'kit-ui-branch';
  const refs = async () => (await account.get(`/api/v1/repos/${id}/refs`)).refs;
  await page.getByRole('button', { name: 'Branches and tags' }).click();
  await atRepo(page, account, id, `/branches`);
  const form = page.getByRole('form', { name: 'Create a branch' });
  await form.getByLabel('New branch').fill(name);
  await form.getByRole('button', { name: 'Create branch' }).click();
  const table = page.getByRole('table', { name: 'Branches' });
  await table.getByRole('cell', { name, exact: true }).waitFor();
  // The API's refs read may answer from a copy up to ACCESS_MS (1 s) old; wait it out.
  const created = await until(async () => {
    const r = await refs();
    return r[`refs/heads/${name}`] ? r : null;
  }, { timeoutMs: 5_000, intervalMs: 250, what: 'the branch made in the page in the API refs' });
  assert.equal(created[`refs/heads/${name}`], created['refs/heads/main'], 'the branch made in the page is not on main');
  await shot('source-branch-created');
  page.once('dialog', (dialog) => dialog.accept());
  await table.getByRole('button', { name: `Delete branch ${name}` }).click();
  await table.getByRole('cell', { name, exact: true }).waitFor({ state: 'detached' });
  await until(async () => (await refs())[`refs/heads/${name}`] === undefined, {
    timeoutMs: 5_000,
    intervalMs: 250,
    what: 'the branch deleted in the page to leave the API refs',
  });
  m.branch_ui = 'created,deleted';
}

/**
 * A change request landed in the UI. The second kit account, a member at write, commits
 * docs/browser-gate.md on a new branch, so the kit account is not its author and may approve
 * it; the kit account opens the change by API, then approves and lands it on the Change page.
 * The member goes with the repository when it is deleted.
 */
export async function changeLanded(page, { origin, kit, account, repo: { id, name }, shot }, m) {
  const api = (path) => `/api/v1/repos/${id}${path}`;
  const member = await secondAccount(origin, kit);
  await account.post(api('/members'), { account: member.name, role: 'write' });
  const base = (await account.get(api('/refs'))).refs['refs/heads/main'];
  await member.session.post(`/repos/${id}/branches`, { ref: 'kit-rebase', commit: base, expected: null });
  const made = await member.session.post(`/repos/${id}/commits`, {
    ref: 'main',
    changes: [{ path: 'docs/browser-gate.md', content_b64: b64('Added by the browser gate.\n') }],
    message: 'Browser gate: add a note',
    author,
  });
  await member.session.post(`/repos/${id}/branches`, { ref: 'kit-browser', commit: made.commit, expected: null });
  const change = await account.post(api('/changes'), { branch: 'kit-browser', title: 'Browser gate change' });
  Object.assign(m, { change: change.number, head: made.commit, author: member.name });

  // The source pages end on account settings: back to the repository through the sidebar.
  await openRepo(page, name);
  await atRepo(page, account, id);
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: 'Changes' }).click();
  await page.getByRole('link', { name: /Browser gate change/ }).click();
  await atRepo(page, account, id, `/changes/${change.number}`);
  // The Gates panel (MergeGates) summarizes what the head still needs; its actions sit in
  // the Landing gates region below it, whose approval reloads the panel.
  const merge = page.getByRole('region', { name: 'Gates', exact: true });
  await merge.getByText(/^Not ready to land/).waitFor();
  const gates = page.getByRole('region', { name: 'Landing gates' });
  await gates.getByRole('button', { name: 'Approve', exact: true }).click();
  await settle(merge.getByText('Ready to land', { exact: true }), [gates.getByRole('alert'), merge.getByRole('alert')], { timeoutMs: 30_000, what: 'approval' });
  await shot('change-approved');
  const started = performance.now();
  await gates.getByRole('button', { name: 'Land on main' }).click();
  await settle(gates.getByText(/^Landed on main at v\d+/), [gates.getByRole('alert')], { timeoutMs: 60_000, what: 'landing' });
  m.land_ui_ms = Math.round(performance.now() - started);
  assert.equal((await page.locator('.source-change-status').first().textContent())?.trim(), 'landed', 'the Change page does not show the change landed');
  await shot('change-landed');
  const after = await account.get(api(`/changes/${change.number}`));
  Object.assign(m, { change_status: after.status, landed_version: after.landed_version });
  assert.equal(after.status, 'landed', `the change is ${after.status} after landing in the UI`);
  assert.equal(after.landed_commit, made.commit, 'the change landed another commit');
  return { member, base };
}

/**
 * "Rebase on main" in the UI. The member commits on kit-rebase, cut from main before the
 * landing above, so the branch is behind main; the kit account opens its change and rebases
 * it on the Change page. The branch must then sit on main's head with a new commit.
 */
export async function changeRebased(page, { origin, account, member, base, repo: { id }, shot }, m) {
  const api = (path) => `/api/v1/repos/${id}${path}`;
  const made = await member.session.post(`/repos/${id}/commits`, {
    ref: 'kit-rebase',
    changes: [{ path: 'docs/rebase.md', content_b64: b64('Rebased by the browser gate.\n') }],
    message: 'Browser gate: a change behind main',
    author,
  });
  await member.session.post(`/repos/${id}/branches`, { ref: 'kit-rebase', commit: made.commit, expected: base });
  const change = await account.post(api('/changes'), { branch: 'kit-rebase', title: 'Browser gate rebase' });
  await page.goto(`${origin}/source/${id}/changes/${change.number}`);
  const box = page.getByRole('region', { name: 'Rebase' });
  const started = performance.now();
  await box.getByRole('button', { name: 'Rebase on main' }).click();
  // The result line, not "Up to date": that follows the page's reads and can show before the rebase answers.
  await settle(box.getByText('Rebased 1 commit(s) on main.'), [page.getByRole('alert')], { timeoutMs: 60_000, what: 'rebase' });
  await box.getByText('Up to date with main.').waitFor();
  m.rebase_ui_ms = Math.round(performance.now() - started);
  await shot('change-rebased');
  const refs = (await account.get(api('/refs'))).refs;
  const after = await account.get(api(`/changes/${change.number}`));
  assert.notEqual(refs['refs/heads/kit-rebase'], made.commit, 'the branch did not move');
  assert.equal(after.diff.base.commit, refs['refs/heads/main'], 'the rebased branch is not on main');
  m.rebased = refs['refs/heads/kit-rebase'];
}
