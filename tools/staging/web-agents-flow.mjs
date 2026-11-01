#!/usr/bin/env node
// Real agents, through the web app, as a user: one Chrome signed in as the dev owner creates a
// repository, turns on what a person would turn on (Landing rules, Automatic Landings, Land when
// cleared, Slop and Intent drift), then commits from the Files page. Nothing is scripted past
// that: the commit's own webhook wakes the managed Worker, its containers call real models, and
// the page has to show what happened without being reloaded. PAID: each run spends real model
// credit, and the flow stops before the cap.
//
//   set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//   node tools/staging/web-agents-flow.mjs [--only clean,noplan,sloppy,drift,never] [--keep]
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
import { CASES, FIX, SLOPPY_FILE } from './web-agents-cases.mjs';
import { AGENTS, addAgent, commitFromPage, createRepository, ctcPage, facts, lookAtForm, pageShows, restore, spentSoFar, turnOnRules } from './web-agents-pages.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    only: { type: 'string', default: 'clean,noplan,sloppy,drift,never' },
    keep: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    looks: { type: 'boolean', default: false },
    'cap-usd': { type: 'string', default: '5' },
  },
});
const origin = values.origin.replace(/\/$/, '');
const CAP_USD = Number(values['cap-usd']);

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

const shot = async (page, label) => page.screenshot({ path: join(dir, `${String(++shots).padStart(2, '0')}-${label}.png`), fullPage: true });

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

/** The dev owner has no handle yet, and the app asks on load. "Not now" keeps it that way. */
function notNow(page) {
  const asking = page.getByRole('dialog', { name: 'Choose your handle' });
  return page.addLocatorHandler(asking, () => asking.getByRole('button', { name: 'Not now' }).click());
}

/** Signs in through the form once; a saved session that still works is kept. */
async function signedIn(browser) {
  const viewport = { width: 1440, height: 1000 };
  if (existsSync(sessionFile)) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: OWN_TRAFFIC, storageState: sessionFile });
    const answer = await context.request.get(`${origin}/api/auth/session`);
    if (answer.ok() && (await answer.json()).authenticated) return context;
    await context.close();
  }
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(username && password, 'set -a; . ~/.config/yonedarepo/dev-owner.env; set +a');
  const context = await browser.newContext({ viewport, extraHTTPHeaders: OWN_TRAFFIC });
  const page = await context.newPage();
  await notNow(page);
  await page.goto(`${origin}/signin`);
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
    const change = await s.api(`/api/v1/repos/${s.repo}/changes/${record.number}`);
    record.facts = await facts(s, record.number, change.head);
    await spentSoFar(s);
    const { slop, drift, status } = record.facts;
    return `${status}; Slop ${slop.value} (${slop.findings} findings, ${slop.container_s} s, $${slop.cost_usd}); Intent ${drift.value} (${drift.container_s} s, $${drift.cost_usd})`;
  });
  record.ctc = await ctcPage(s, c.id);
  await s.page.goto(`${origin}${s.base}/changes/${record.number}`);
  await s.page.getByRole('heading', { level: 2 }).first().waitFor();
  await sleep(1500);
  await s.shot(`${c.id}-reloaded`);
  return { seen, said };
}

async function main() {
  const chosen = values.only.split(',').map((x) => x.trim());
  for (const id of chosen) assert.ok(CASES[id], `--only takes ${Object.keys(CASES).join(', ')}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: !values.headed });
  const context = await signedIn(browser);
  const page = await context.newPage();
  watchPage(page);
  await notNow(page);
  const name = `agents-live-${ts}`;
  const s = { context, page, name, origin, out, capUsd: CAP_USD, defaultBlock: 'high', api: (path, init) => api(context, path, init), shot: (label) => shot(page, label) };
  let failed = false;
  try {
    const { repos } = await api(context, '/api/v1/repos');
    const session = await api(context, '/api/auth/session');
    const workspace = session.username;
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
    for (const agent of AGENTS) await step(`Add ${agent.name}, Block landing at left alone`, () => addAgent(s, agent));

    if (values.looks) await step('The form: wide, phone, light, dark, error, keyboard', () => lookAtForm(s));
    for (const id of chosen.filter((x) => x !== 'never')) await flyCase(s, CASES[id]);

    if (chosen.includes('sloppy') && out.cases.sloppy?.facts?.status === 'open') {
      // The go-around, answered from the web too: edit the file on its branch, and agents look again.
      const at = `/files/${SLOPPY_FILE}?ref=${encodeURIComponent(CASES.sloppy.branch)}`;
      await flyCase(s, FIX, { at, edit: true });
    }
    if (chosen.includes('never')) {
      // A user can still lower it: the same off-course work, with Never chosen on the page.
      for (const agent of AGENTS) await step(`Set ${agent.name} to Never`, () => addAgent(s, agent, ''));
      await flyCase(s, CASES.never);
    }
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
  console.table(Object.entries(out.cases).map(([id, c]) => ({ case: id, slop: c.facts?.slop.value, drift: c.facts?.drift.value, status: c.facts?.status, page: c.page?.state, expected: c.expected?.outcome })));
  console.log(`\nEvidence: ${dir}\nSpent: $${out.spent_usd}`);
  console.table(out.steps.map(({ step: n, title, ms, result }) => ({ n, title: title.slice(0, 60), s: (ms / 1000).toFixed(1), result: result.slice(0, 60) })));
  return failed ? 1 : 0;
}

process.exitCode = await main();
