// Browser gate (kit item `browser`): headless system Chrome (playwright-core, channel `chrome`)
// drives the served app as a person does, with zero model spend. It signs the kit account in
// through the real login form, creates a repository with the shell's "New repository" dialog,
// opens its Code, History, Changes (the empty list) and Settings (Landing rules, Connect) tabs
// and the account Settings page. Then the second kit account (a member at write) commits on a
// branch by API, the kit account opens a change for it and approves and lands it in the Change
// page (the platform refuses an author's own approval); the page and the API must both read it
// back landed. Each step's screenshot goes to .local/staging/browser-<ts>/; a
// failure adds the page text and console errors there. The API (with the browser's own session
// cookie) is used only to set up the change, read back and clean up.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { b64, Session, secondAccount, sleep } from './client.mjs';

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

export async function browserFlow({ origin, kit, root, headed = false }, m) {
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
    await signIn(page, origin, kit);
    await shot('signed-in');
    const account = new Session(origin, { cookie: cookieHeader(await context.cookies(origin)) });
    const repo = await sourcePages(page, origin, account, { shot, cleanup }, m);
    await changeLanded(page, { origin, kit, account, repo, shot }, m);
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

/** The real login form on the welcome page; the kit password is typed only here. */
export async function signIn(page, origin, { KIT_USERNAME, KIT_PASSWORD }) {
  await page.goto(origin);
  await page.getByRole('navigation', { name: 'Account access' }).getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Username or email').fill(KIT_USERNAME);
  const password = page.getByLabel('Password', { exact: true });
  await password.fill(KIT_PASSWORD);
  await password.press('Enter');
  await settle(page.getByRole('button', { name: 'New repository' }).first(), [page.getByRole('alert')], { timeoutMs: 30_000, what: 'sign-in' });
}

/** "New repository" opens a dialog that creates a platform repository seeded with a README. */
export async function newRepository(page, name) {
  await page.getByRole('button', { name: 'New repository' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New repository' });
  await dialog.getByLabel('Repository name').fill(name);
  await dialog.getByRole('button', { name: 'Create repository' }).click();
}

/** A platform repository: create it, open its tabs and the account settings; deleted by API at the end. */
export async function sourcePages(page, origin, account, { shot, cleanup }, m) {
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
  await page.getByRole('navigation', { name: 'Repositories' }).getByRole('link', { name, exact: true }).waitFor();
  await page.waitForURL(`**/source/${id}`);
  await page.getByRole('region', { name: 'Files' }).getByText('README.md').first().waitFor();
  await shot('source-code');
  const tabs = page.getByRole('navigation', { name: 'Repository' });
  await tabs.getByRole('link', { name: 'History' }).click();
  await page.getByRole('list', { name: 'History of main' }).getByRole('listitem').first().waitFor();
  await shot('source-history');
  await tabs.getByRole('link', { name: 'Changes' }).click();
  await page.waitForURL(`**/source/${id}/changes`);
  await page.getByText('No open changes.').waitFor();
  await shot('source-changes');
  await tabs.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Landing rules' }).waitFor();
  await shot('source-settings');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Connect' }).click();
  await page.getByRole('heading', { name: 'Clone with git' }).waitFor();
  await shot('source-connect');
  // The account menu (top right): its summary is labelled "Account: <name>".
  const menu = page.locator('details.account-menu');
  await menu.getByLabel(/^Account:/).click();
  await menu.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
  await page.getByRole('heading', { name: 'Personal access tokens' }).waitFor();
  await shot('account-settings');
  m.source_pages = 'code,history,changes,settings,connect,account-settings';
  return { id, name };
}

/**
 * A change request landed in the UI. The second kit account, a member at write, commits
 * docs/browser-gate.md on a new branch, so the kit account is not its author and may approve
 * it; the kit account opens the change by API, then approves and lands it on the Change page.
 * The member goes with the repository when it is deleted.
 */
export async function changeLanded(page, { origin, kit, account, repo: { id }, shot }, m) {
  const api = (path) => `/api/v1/repos/${id}${path}`;
  const member = await secondAccount(origin, kit);
  await account.post(api('/members'), { account: member.name, role: 'write' });
  const made = await member.session.post(`/repos/${id}/commits`, {
    ref: 'main',
    changes: [{ path: 'docs/browser-gate.md', content_b64: b64('Added by the browser gate.\n') }],
    message: 'Browser gate: add a note',
    author,
  });
  await member.session.post(`/repos/${id}/branches`, { ref: 'kit-browser', commit: made.commit, expected: null });
  const change = await account.post(api('/changes'), { branch: 'kit-browser', title: 'Browser gate change' });
  Object.assign(m, { change: change.number, head: made.commit, author: member.name });

  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: 'Changes' }).click();
  await page.getByRole('link', { name: /Browser gate change/ }).click();
  await page.waitForURL(`**/source/${id}/changes/${change.number}`);
  await page.getByRole('heading', { name: 'Not ready to land' }).waitFor();
  const gates = page.getByRole('region', { name: 'Landing gates' });
  await gates.getByRole('button', { name: 'Approve', exact: true }).click();
  await settle(gates.getByRole('heading', { name: 'Ready to land' }), [gates.getByRole('alert')], { timeoutMs: 30_000, what: 'approval' });
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
}
