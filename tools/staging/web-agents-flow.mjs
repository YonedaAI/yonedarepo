#!/usr/bin/env node
// Real agents, through the web app, as a user: one Chrome signed in as the dev owner creates a
// repository, turns on what a person would turn on (Landing rules, Automatic Landings, Land when
// cleared, Slop and Intent drift), then commits from the Files page. Nothing is scripted past
// that: the commit's own webhook wakes the managed Worker, its containers call real models, and
// the page has to show what happened without being reloaded. PAID: each run spends real model
// credit, and the flow stops before the cap.
//
//   set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//   node tools/staging/web-agents-flow.mjs [--only clean,sloppy,drift,default] [--keep]
//        [--cap-usd 5] [--origin https://dev.yonedarepo.com]
//
// The login is kept in <root>/.local/agents-live/session.json, 0600, so a rerun is no new session.
// Evidence: <root>/.local/agents-live/<ts>/: screenshots, and results.json with every step.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { OWN_TRAFFIC } from './client.mjs';
import { CASES, DRIFT_FILE, FIX, FIXED_GOAL, SLOPPY_FILE } from './web-agents-cases.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    only: { type: 'string', default: 'clean,sloppy,drift,default' },
    keep: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    'cap-usd': { type: 'string', default: '5' },
  },
});
const origin = values.origin.replace(/\/$/, '');
const CAP_USD = Number(values['cap-usd']);
const AGENTS = [
  { id: 'slop-review', name: 'Slop review', check: 'slop-review' },
  { id: 'intent-drift', name: 'Intent drift', check: 'intent-drift' },
];
/** A container's start, a model's reply and the workflow's 20 s poll, twice over. */
const AGENT_MS = 8 * 60_000;
/** CTC's job after the last check. */
const LAND_MS = 3 * 60_000;
const TERMINAL = new Set(['passed', 'findings', 'failed', 'superseded', 'cancelled', 'paused']);

const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const local = join(root, '.local/agents-live');
const ts = Date.now();
const dir = join(local, String(ts));
mkdirSync(dir, { recursive: true });
const sessionFile = join(local, 'session.json');

const out = { ts, origin, steps: [], cases: {}, problems: [] };
const save = () => writeFileSync(join(dir, 'results.json'), JSON.stringify(out, null, 2));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let shots = 0;

async function step(title, body) {
  const started = performance.now();
  const row = { step: out.steps.length + 1, title, ms: 0, result: 'failed' };
  out.steps.push(row);
  try {
    row.result = String((await body()) ?? 'ok');
    return row.result;
  } catch (e) {
    row.error = e.message.slice(0, 600);
    throw e;
  } finally {
    row.ms = Math.round(performance.now() - started);
    console.log(`${String(row.step).padStart(3)} ${title}: ${row.error ? `FAILED ${row.error.slice(0, 300)}` : row.result} (${row.ms} ms)`);
    save();
  }
}

/** Signs in through the form once; a saved session that still works is kept. */
async function signedIn(browser) {
  const viewport = { width: 1440, height: 1000 };
  if (existsSync(sessionFile)) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: OWN_TRAFFIC, storageState: sessionFile });
    const answer = await context.request.get(`${origin}/api/auth/session`);
    if (answer.ok() && (await answer.json()).account) return context;
    await context.close();
  }
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(username && password, 'set -a; . ~/.config/yonedarepo/dev-owner.env; set +a');
  const context = await browser.newContext({ viewport, extraHTTPHeaders: OWN_TRAFFIC });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('navigation', { name: 'Account access' }).getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'New repository' }).first().waitFor({ timeout: 30_000 });
  await context.storageState({ path: sessionFile });
  chmodSync(sessionFile, 0o600);
  await page.close();
  return context;
}

function watchPage(page) {
  page.setDefaultTimeout(30_000);
  page.on('console', (m) => m.type() === 'error' && out.problems.push(`console: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => out.problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('response', (r) => r.status() >= 400 && out.problems.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
}

const api = async (context, path, init) => {
  const answer = await context.request.fetch(`${origin}${path}`, { headers: { origin }, ...init });
  assert.ok(answer.ok(), `${init?.method ?? 'GET'} ${path}: ${answer.status()} ${(await answer.text()).slice(0, 300)}`);
  return answer.json();
};

/** A run per agent on this head, once each has finished. */
async function runsOn(s, head) {
  const started = Date.now();
  for (;;) {
    const { runs } = await api(s.context, `${s.managed}/runs?repo=${s.repo}&limit=50`);
    const mine = AGENTS.map((a) => runs.find((r) => r.agent === a.id && r.head === head));
    if (mine.every((r) => r && TERMINAL.has(r.status))) return mine;
    if (Date.now() - started > AGENT_MS) {
      const said = mine.map((r, i) => `${AGENTS[i].id}:${r?.status ?? 'none'}`).join(' ');
      throw new Error(`runs on ${head.slice(0, 8)} unfinished after ${AGENT_MS / 60_000} min: ${said}`);
    }
    await sleep(5_000);
  }
}

/** Stops the flow before it can pass the cap. */
async function spentSoFar(s) {
  const { credit } = await api(s.context, s.managed);
  const spent = credit.used_usd - s.creditBefore.used_usd;
  out.spent_usd = Number(spent.toFixed(6));
  assert.ok(spent < CAP_USD * 0.8, `spent $${spent.toFixed(4)}, within 20% of the $${CAP_USD} cap`);
  return spent;
}

const shot = async (page, label) => page.screenshot({ path: join(dir, `${String(++shots).padStart(2, '0')}-${label}.png`), fullPage: true });

async function createRepository(s) {
  await s.page.goto(`${origin}/repositories`);
  await s.page.getByRole('button', { name: 'New repository' }).first().click();
  const dialog = s.page.getByRole('dialog');
  await dialog.getByLabel('Repository name').fill(s.name);
  await shot(s.page, 'new-repository');
  await dialog.getByRole('button', { name: 'Create repository' }).click();
  await s.page.waitForURL(/\/source\/r[0-9a-f]{20}|\/[^/]+\/[^/]+$/);
  await s.page.getByRole('button', { name: 'Add file' }).waitFor();
  s.repo = (await api(s.context, '/api/v1/repos')).repos.find((r) => r.name === s.name).id;
  s.base = `/source/${s.repo}`;
  out.repo = s.repo;
  await shot(s.page, 'repository');
  return s.repo;
}

async function turnOnRules(s) {
  const { page } = s;
  await page.goto(`${origin}${s.base}/settings`);
  await page.getByLabel('Approvals needed to land on main').fill('0');
  await page.getByLabel('Required checks').fill(AGENTS.map((a) => a.check).join('\n'));
  await page.getByRole('button', { name: /^Save / }).first().click();
  await page.getByText(/^Saved\./).waitFor();
  for (const name of ['Open a Landing for every pushed branch', 'Run agents on automatic Landings', 'Land when cleared']) {
    const box = page.getByRole('checkbox', { name });
    await box.check();
    await page.waitForFunction((n) => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes(n));
      return label?.querySelector('input')?.checked && !label.closest('fieldset').disabled;
    }, name);
  }
  await shot(page, 'landing-rules');
  const status = await api(s.context, `/api/v1/repos/${s.repo}`);
  assert.deepEqual(
    [status.landings.create, status.landings.agents, status.landings.land_when_cleared],
    [true, true, true],
    'the switches read back',
  );
  return JSON.stringify(status.policy?.required_checks ?? null);
}

/**
 * Add agent through its page. A first set-up ticks every repository the account owns, so the save
 * is opened and refused unless it names this one and what was already on: a click here must not
 * start paid runs on anyone else's work.
 */
async function addAgent(s, agent, block) {
  const { page } = s;
  const before = s.agentsBefore.find((a) => a.id === agent.id);
  const allowed = new Set([...before.enabled_repos, s.repo]);
  await page.route(`**/api/managed/workspaces/*/agents/${agent.id}`, (route) => {
    const body = route.request().postDataJSON();
    const named = body?.repos ?? [];
    const safe = !body?.all_repos && named.every((r) => allowed.has(r)) && named.includes(s.repo);
    if (!safe) out.problems.push(`refused a save naming ${named.length} repositories, all_repos=${body?.all_repos}`);
    return safe ? route.continue() : route.abort();
  });
  await page.goto(`${origin}/agents/${agent.id}/configure`);
  await page.getByRole('heading', { level: 1, name: /(Set up|Configure) / }).waitFor();
  await page.getByRole('radio', { name: 'Only the repositories I choose' }).check();
  const chosen = page.getByRole('group', { name: 'Chosen repositories' });
  for (const box of await chosen.getByRole('checkbox').all()) {
    const label = await box.evaluate((el) => el.closest('label')?.textContent ?? '');
    const id = s.reposByName.get(label.trim()) ?? null;
    const wanted = label.includes(s.name) || (id && before.enabled_repos.includes(id));
    if (wanted) await box.check();
    else await box.uncheck();
  }
  await page.getByLabel('Block landing at').selectOption(block);
  await shot(page, `add-${agent.id}`);
  await page.getByRole('button', { name: /^(Add agent|Save changes)$/ }).click();
  await page.waitForURL(new RegExp(`/agents/${agent.id}(\\?|$)|/agents/${agent.id}/configure`));
  await sleep(1500);
  await page.unroute(`**/api/managed/workspaces/*/agents/${agent.id}`);
  const state = (await api(s.context, s.managed)).agents.find((a) => a.id === agent.id);
  assert.ok(state.enabled_repos.includes(s.repo), `${agent.id} is not on the repository`);
  assert.equal(state.settings.block_at, block || null, 'the level read back');
  await shot(page, `agent-${agent.id}`);
  return `on, block ${block || 'never'}, model ${state.settings.provider}/${state.settings.model}`;
}

/** The Files page's form, filled as a person would, on the branch or file `at` points to. */
async function commitFromPage(s, c, { at = '', edit = false } = {}) {
  const { page } = s;
  await page.goto(`${origin}${s.base}${at}`);
  await page.getByRole('button', { name: edit ? 'Edit' : 'Add file' }).click();
  const form = page.getByRole('form', { name: edit ? `Edit ${c.path}` : 'Add a file' });
  if (!edit) await form.getByLabel('File').fill(c.path);
  await form.getByLabel('Contents').fill(c.content);
  await form.getByLabel('Commit message').fill(c.message);
  if (c.branch) await form.getByLabel('Branch').fill(c.branch);
  if (c.goal) await form.getByLabel('Flight plan').fill(c.goal);
  await shot(page, `${c.id}-form`);
  await form.getByRole('button', { name: 'Commit' }).click();
  await page.waitForURL(/\/changes\/\d+$/, { timeout: 30_000 });
  const number = Number(page.url().match(/(\d+)$/)[1]);
  await page.getByRole('heading', { level: 2, name: c.message }).waitFor();
  await shot(page, `${c.id}-landing-opened`);
  return number;
}

/** Waits on the open page, never reloading it: what a person sees is what the test sees. */
async function pageShows(s, c, number) {
  const { page } = s;
  const started = Date.now();
  const cards = page.locator('.source-instruments');
  await cards.getByText(/Slop/).waitFor({ timeout: AGENT_MS });
  await cards.getByText(/Intent drift/).waitFor({ timeout: AGENT_MS });
  await page.waitForFunction(() => !document.querySelector('.source-instruments')?.textContent.includes('Not reviewed yet'), null, { timeout: AGENT_MS });
  const shownS = Math.round((Date.now() - started) / 1000);
  await shot(page, `${c.id}-instruments`);
  const chip = page.locator('.source-change header .source-change-status');
  await page.waitForFunction(() => /Landed|Go-around/.test(document.querySelector('.source-change header .source-change-status')?.textContent ?? ''), null, { timeout: LAND_MS }).catch(() => {});
  const state = (await chip.innerText()).trim();
  await shot(page, `${c.id}-landing-final`);
  return { shownS, state, text: (await cards.innerText()).replace(/\s+/g, ' ').slice(0, 300), number };
}

/** The API's word on it, to hold the page to. */
async function facts(s, number, head) {
  const [slop, drift] = await runsOn(s, head);
  const change = await api(s.context, `/api/v1/repos/${s.repo}/changes/${number}`);
  const checks = Object.fromEntries((change.head_commit?.checks ?? []).map((k) => [k.name, k.status]));
  const summary = (r) => ({
    status: r.status,
    value: r.value,
    model: `${r.provider}/${r.model}`,
    fallback: r.fallback ?? null,
    harness: r.harness,
    container_s: r.container_seconds,
    calls: r.calls,
    tokens_in: r.input_tokens,
    tokens_out: r.output_tokens,
    cost_usd: r.cost_usd,
    findings: r.findings,
    error: r.error ?? null,
    summary: r.summary ?? null,
    took_s: r.finished_at ? Math.round((r.finished_at - r.created_at) / 1000) : null,
  });
  return {
    status: change.status,
    head,
    landed_commit: change.landed_commit ?? null,
    plan: change.flight_plan?.goal ?? null,
    checks,
    slop: summary(slop),
    drift: summary(drift),
    comments: change.comments.map((c) => ({ path: c.path, line: c.line, body: String(c.body).slice(0, 200) })),
    clearances: (change.clearances ?? []).map((k) => ({ decision: k.decision, head: k.head?.slice(0, 8), reasons: k.reasons?.map((r) => r.code), at: k.at })),
  };
}

async function ctcPage(s, label) {
  await s.page.goto(`${origin}${s.base}/ctc`);
  await s.page.getByRole('heading', { name: /Code Traffic Control|CTC/ }).first().waitFor();
  await sleep(1000);
  await shot(s.page, `${label}-ctc`);
  return (await s.page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 400);
}

async function flyCase(s, c, options) {
  const record = {};
  out.cases[c.id] = record;
  record.expected = c.expect;
  const number = await step(`${c.id}: commit from the Files page`, () => commitFromPage(s, c, options));
  record.number = Number(number);
  const seen = await step(`${c.id}: the open page shows the agents' values, unreloaded`, async () => {
    const shown = await pageShows(s, c, record.number);
    record.page = shown;
    return `${shown.state} after ${shown.shownS} s: ${shown.text.slice(0, 120)}`;
  });
  const said = await step(`${c.id}: real runs on this commit`, async () => {
    const change = await api(s.context, `/api/v1/repos/${s.repo}/changes/${record.number}`);
    record.facts = await facts(s, record.number, change.head);
    await spentSoFar(s);
    const { slop, drift, status } = record.facts;
    return `${status}; Slop ${slop.value} (${slop.findings} findings, ${slop.container_s} s, $${slop.cost_usd}); Intent ${drift.value} (${drift.container_s} s, $${drift.cost_usd})`;
  });
  record.ctc = await ctcPage(s, c.id);
  await s.page.goto(`${origin}${s.base}/changes/${record.number}`);
  await s.page.getByRole('heading', { level: 2 }).first().waitFor();
  await sleep(1500);
  await shot(s.page, `${c.id}-reloaded`);
  return { seen, said };
}

async function restore(s) {
  for (const before of s.agentsBefore) {
    if (!AGENTS.some((a) => a.id === before.id)) continue;
    const body = {
      repos: before.enabled_repos,
      ...(before.all_repos ? { all_repos: true } : {}),
      settings: { block_at: before.settings.block_at },
    };
    await api(s.context, `${s.managed}/agents/${before.id}`, { method: 'PUT', data: body });
  }
  const after = (await api(s.context, s.managed)).agents;
  return after.filter((a) => AGENTS.some((b) => b.id === a.id)).map((a) => `${a.id}: ${a.enabled_repos.length} repos, block ${a.settings.block_at}`).join('; ');
}

async function main() {
  const chosen = values.only.split(',').map((x) => x.trim());
  for (const id of chosen) assert.ok(CASES[id], `--only takes ${Object.keys(CASES).join(', ')}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: !values.headed });
  const context = await signedIn(browser);
  const page = await context.newPage();
  watchPage(page);
  // The dev owner has no handle yet, and the app asks on load. "Not now" keeps it that way.
  const asking = page.getByRole('dialog', { name: 'Choose your handle' });
  await page.addLocatorHandler(asking, () => asking.getByRole('button', { name: 'Not now' }).click());
  const name = `agents-live-${ts}`;
  const s = { context, page, name };
  let failed = false;
  try {
    const { repos } = await api(context, '/api/v1/repos');
    const session = await api(context, '/api/auth/session');
    const workspace = session.account;
    s.managed = `/api/managed/workspaces/${encodeURIComponent(workspace)}`;
    const state = await api(context, s.managed);
    s.creditBefore = state.credit;
    s.agentsBefore = state.agents;
    s.reposByName = new Map(state.repos.map((r) => [r.name, r.id]));
    out.credit_before = { balance_usd: state.credit.balance_usd, used_usd: state.credit.used_usd };
    out.agents_before = state.agents.map((a) => ({ id: a.id, enabled_repos: a.enabled_repos.length, all_repos: a.all_repos, block_at: a.settings.block_at }));
    assert.ok(state.credit.balance_usd > 0.5, `workspace credit is $${state.credit.balance_usd}: grant it first`);
    assert.ok(!state.agents.some((a) => a.all_repos), 'an agent runs on every repository of this account: stop');
    console.log(`Workspace has ${repos.length} repositories, $${state.credit.balance_usd} credit.`);

    await step('Create a repository from the dialog', () => createRepository(s));
    await step('Landing rules: 0 approvals, 2 required checks, the 3 switches', () => turnOnRules(s));
    for (const agent of AGENTS) await step(`Add ${agent.name}, blocking at medium`, () => addAgent(s, agent, 'medium'));

    for (const id of chosen.filter((x) => x !== 'default')) await flyCase(s, CASES[id]);

    if (chosen.includes('sloppy') && out.cases.sloppy?.facts?.status === 'open') {
      // The go-around, answered from the web too: edit the file on its branch, and agents look again.
      const at = `/files/${SLOPPY_FILE}?ref=${encodeURIComponent(CASES.sloppy.branch)}`;
      await flyCase(s, FIX, { at, edit: true });
    }
    if (chosen.includes('default')) {
      // What a user who never touches Block landing at gets on the same off-course change.
      for (const agent of AGENTS) await step(`Set ${agent.name} back to never blocking`, () => addAgent(s, agent, ''));
      await flyCase(s, CASES.default);
    }
    out.fixed_goal = FIXED_GOAL;
    out.drift_file = DRIFT_FILE;
  } catch (e) {
    failed = true;
    await shot(page, 'failure').catch(() => {});
    writeFileSync(join(dir, 'failure.txt'), `${e.stack}\n\nURL: ${page.url()}\n\n${await page.locator('body').innerText().catch(() => '')}\n`);
    console.log(`FAILED: ${e.message.slice(0, 500)}`);
  } finally {
    if (s.repo) {
      await step('Put the agents back as they were', () => restore(s)).catch(() => {
        failed = true;
      });
      if (values.keep) console.log(`KEEP: ${name} (${s.repo})`);
      else
        await step('Delete the repository', async () => {
          await api(context, `/api/v1/repos/${s.repo}?confirm=${encodeURIComponent(name)}`, { method: 'DELETE' });
          return s.repo;
        }).catch(() => {
          failed = true;
        });
    }
    if (s.creditBefore) await spentSoFar(s).catch((e) => out.problems.push(e.message));
    save();
    await context.storageState({ path: sessionFile }).catch(() => {});
    await browser.close();
  }
  console.log(`\nEvidence: ${dir}\nSpent: $${out.spent_usd}`);
  console.table(out.steps.map(({ step: n, title, ms, result }) => ({ n, title: title.slice(0, 60), s: (ms / 1000).toFixed(1), result: result.slice(0, 60) })));
  return failed ? 1 : 0;
}

process.exitCode = await main();
