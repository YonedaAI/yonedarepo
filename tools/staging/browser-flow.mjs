// Browser gate (kit item `browser`): headless system Chrome (playwright-core, channel `chrome`)
// drives the served app as a person does. It signs the kit account in through the real login form,
// creates a repository with the shell's "New repository" dialog and opens its Code, History,
// Changes (the empty list) and Settings (Landing rules, Connect) tabs and the account Settings
// page, then creates a repository with agent runs (a project), starts a compare run with two cheap
// agents (managed GLM flash on opencode), waits for "Choose a result", uses the first checked
// result, publishes it and checks the readback and the moved project head. When the "Delete run"
// control exists it deletes the run and checks Run history; otherwise it records
// `delete=unavailable`. Each step's screenshot goes to .local/staging/browser-<ts>/; a failure adds
// the page text and console errors there. The API (with the browser's own session cookie) is used
// only for funding, waiting, readback and cleanup.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { Session, sleep, until } from './client.mjs';
import { bindManagedProviders, compareState, deleteProject, ensureAllowance, runFailure, spend } from './project-flow.mjs';

/** Spend cap per gate run (GLM flash only); the item fails above it. */
export const BROWSER_TARGET_USD = 0.05;
export const BROWSER_AGENTS = [
  { connection: 'managed-zai', cli: 'opencode' },
  { connection: 'managed-zai', cli: 'opencode' },
];
// The reasons the browser disables "Use this result" (comparisonView.ts comparisonChoiceBlocker).
const CHOICE_BLOCKER = /cannot select|Wait for building|already in progress|not ready|needs completed|needs exact|Refresh before choosing/;
const BRIEF ='Create docs/browser-gate.md containing one sentence that says this file was added by the browser gate. Do not modify any other file.';

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

export async function browserFlow({ origin, owner, kit, root, timeoutMs = 10 * 60_000, headed = false }, m) {
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
    await sourcePages(page, origin, account, { shot, cleanup }, m);
    await bindManagedProviders(owner, kit.KIT_USERNAME);
    await ensureAllowance(account, owner, kit.KIT_USERNAME);
    await projectRun(page, origin, account, { shot, cleanup, timeoutMs }, m);
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
  if (Number(m.spend_usd) > BROWSER_TARGET_USD) throw new Error(`Spent $${m.spend_usd}, over the $${BROWSER_TARGET_USD} cap`);
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

/** "New repository" opens a dialog; with `agents` it creates a project (agent runs). */
export async function newRepository(page, name, { agents = false } = {}) {
  await page.getByRole('button', { name: 'New repository' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New repository' });
  await dialog.getByLabel('Repository name').fill(name);
  if (agents) await dialog.getByLabel('Agent runs').check();
  await dialog.getByRole('button', { name: 'Create repository' }).click();
}

/** A platform repository: create it, open its tabs and the account settings, then delete it by API. */
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
}

/** Workspace: new project, compare run, owner choice, publication, readback, run deletion. */
async function projectRun(page, origin, account, { shot, cleanup, timeoutMs }, m) {
  await page.goto(origin);
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST');
  await newRepository(page, `kit-browser-${Date.now()}`, { agents: true });
  const response = await created;
  assert.ok(response.ok(), `Create project: HTTP ${response.status()}`);
  const { id } = await response.json();
  m.project = id;
  const started = performance.now();
  const project = await until(
    async () => {
      const p = await account.get(`/api/projects/${id}`);
      assert.notEqual(p.status, 'failed', `Project failed: ${p.error_code} ${p.error ?? ''}`);
      return p.status === 'ready' && p;
    },
    { timeoutMs: 300_000, what: 'project ready' },
  );
  cleanup.push(() => deleteProject(account, project, m));
  m.project_ready_s = ((performance.now() - started) / 1000).toFixed(1);
  await page.getByRole('heading', { level: 1, name: 'Development runs' }).waitFor({ timeout: 120_000 });
  const platform = `/api/v1/repos/${project.platform.repo}`;
  const before = { snap: await account.get(`/api/repos/${id}/snapshot`), main: (await account.get(`${platform}/refs`)).refs['refs/heads/main'] };

  const runId = await startRun(page, shot);
  m.run = runId;
  await until(
    async () => {
      const detail = await account.get(`/api/repos/${id}/runs/${runId}`);
      m.spend_usd = spend(detail.run).toFixed(4);
      const state = compareState(detail);
      if (state.status === 'failed') throw new Error(`Run ${detail.run.status}, ${state.reason}: ${runFailure(detail)}`);
      m.eligible = state.eligible.length;
      return state.status === 'choose';
    },
    { timeoutMs, intervalMs: 10_000, what: 'a checked result' },
  );
  await page.getByRole('heading', { level: 3, name: 'Choose a result' }).waitFor({ timeout: 60_000 });
  await shot('choose-a-result');
  await chooseAndPublish(page, shot);

  const detail = await account.get(`/api/repos/${id}/runs/${runId}`);
  m.spend_usd = spend(detail.run).toFixed(4);
  const recorded = (detail.decisions ?? []).find((d) => d.run_id === runId);
  assert.equal(recorded?.status, 'published', `Readback did not record publication (${recorded?.status ?? 'no decision'})`);
  const after = { snap: await account.get(`/api/repos/${id}/snapshot`), main: (await account.get(`${platform}/refs`)).refs['refs/heads/main'] };
  assert.equal(after.snap.repository.published_commit, recorded.target?.commit, 'Snapshot does not show the published commit');
  assert.notEqual(after.snap.repository.head_commit, before.snap.repository.head_commit, 'Project head did not change');
  assert.notEqual(after.main, before.main, 'Platform main did not move');
  m.published = recorded.target.commit.slice(0, 12);

  m.delete = await deleteRun(page, account, id, runId, shot);
}

/** "Use this result" on the first checked result, then "Publish result" with its confirmation. */
export async function chooseAndPublish(page, shot) {
  const results = page.getByRole('region', { name: 'Comparison results' });
  // "Choose a result" can show while every choice is still blocked; say why instead of timing out.
  const usable = results.getByRole('button', { name: 'Use this result', disabled: false });
  await usable.first().waitFor({ timeout: 60_000 }).catch(async () => {
    const blockers = await results.getByText(CHOICE_BLOCKER).allInnerTexts();
    throw new Error(`No usable "Use this result": ${[...new Set(blockers)].join('; ') || 'no reason shown'}`);
  });
  await usable.first().click();
  const choice = page.getByRole('dialog', { name: 'Use this result' });
  await choice.getByLabel('Why use this result?').fill('Browser gate: first checked result');
  await choice.getByRole('button', { name: 'Use this result' }).click();
  await settle(results.getByRole('button', { name: 'Publish result', disabled: false }), [choice.getByRole('alert')], { timeoutMs: 60_000, what: 'use this result' });
  await shot('result-chosen');
  await results.getByRole('button', { name: 'Publish result', disabled: false }).first().click();
  const decision = page.getByRole('dialog', { name: 'Record publishing decision' });
  await decision.getByLabel('I confirm publication of this exact checked result.').check();
  await decision.getByRole('button', { name: 'Publish result' }).click();
  await settle(page.getByRole('heading', { level: 3, name: 'Published', exact: true }), [page.getByRole('alert')], { timeoutMs: 180_000, what: 'publication' });
  await shot('published');
}

/** The composer: two managed GLM flash agents on opencode; returns the run id it sent. */
export async function startRun(page, shot) {
  await page.getByRole('button', { name: 'Start a Run' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Start a Run' });
  await dialog.getByLabel('What would you like to do?').fill(BRIEF);
  await dialog.getByText('Loading connected models…').waitFor({ state: 'detached' });
  for (let i = 1; i < BROWSER_AGENTS.length; i += 1) await dialog.getByRole('button', { name: 'Add agent' }).click();
  for (const [index, agent] of BROWSER_AGENTS.entries()) {
    await dialog.getByLabel(`Model for agent ${index + 1}`).selectOption(agent.connection);
    await dialog.getByLabel(`Coding CLI for agent ${index + 1}`).selectOption(agent.cli);
  }
  await shot('run-composer');
  const sent = page.waitForResponse((r) => r.url().endsWith('/start_run') && r.request().method() === 'POST', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Start a Run' }).click();
  const response = await sent;
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok(), `Start run: HTTP ${response.status()} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`);
  const runId = response.request().postDataJSON().id;
  assert.ok(runId, 'The start request carried no run id');
  await dialog.waitFor({ state: 'detached' });
  return runId;
}

/** "Delete run" with its confirm; `unavailable` until that control ships. */
export async function deleteRun(page, account, repo, runId, shot) {
  const trigger = page.getByRole('button', { name: 'Delete run', exact: true });
  if (!(await trigger.count())) await page.getByRole('tab', { name: 'Run details' }).click();
  if (!(await trigger.count())) return 'unavailable';
  if (await trigger.isDisabled()) throw new Error(`Delete run is disabled: ${(await trigger.getAttribute('title')) ?? 'no reason shown'}`);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Delete this run?' });
  await dialog.getByRole('button', { name: 'Confirm delete run' }).click();
  await until(
    async () => {
      // A refused delete lands in the workspace's error banner.
      const alert = page.getByRole('alert').first();
      if (await alert.isVisible().catch(() => false)) throw new Error(`Delete run: ${(await alert.innerText()).slice(0, 300)}`);
      return (await account.raw('GET', `/api/repos/${repo}/runs/${runId}`)).status >= 400;
    },
    { timeoutMs: 60_000, intervalMs: 2000, what: 'run deleted' },
  );
  await until(
    async () => {
      const history = page.getByLabel('Run history');
      const values = (await history.count()) ? await history.locator('option').evaluateAll((options) => options.map((o) => o.value)) : [];
      return !values.includes(runId);
    },
    { timeoutMs: 30_000, intervalMs: 1000, what: 'run gone from Run history' },
  );
  await shot('run-deleted');
  return 'deleted';
}
