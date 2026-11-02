// The web half of demo-repos.mjs: one Chrome signed in as the dev owner (the saved login, so a
// rerun is no new session) forks a real-history repository and turns on what a person would turn
// on, through the pages web-agents-flow.mjs drives. Each step reads first, so a rerun skips it.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { OWN_TRAFFIC } from './client.mjs';
import { addAgent, AGENTS, turnOnRules } from './web-agents-pages.mjs';

const VIEWPORT = { width: 1440, height: 1000 };

/** The saved session in a new Chrome; `{ browser, context, page, api, close }`. */
export async function openWeb({ origin, sessionFile }) {
  assert.ok(existsSync(sessionFile), `no saved login at ${sessionFile}: run web-agents-flow.mjs once`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, extraHTTPHeaders: OWN_TRAFFIC, storageState: sessionFile });
  const answer = await context.request.get(`${origin}/api/auth/session`);
  assert.ok(answer.ok() && (await answer.json()).authenticated, 'the saved login no longer works');
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const asking = page.getByRole('dialog', { name: 'Choose your handle' });
  await page.addLocatorHandler(asking, () => asking.getByRole('button', { name: 'Not now' }).click());
  const api = async (path, init) => {
    const done = await context.request.fetch(`${origin}${path}`, { headers: { origin }, ...init });
    assert.ok(done.ok(), `${init?.method ?? 'GET'} ${path}: ${done.status()} ${(await done.text()).slice(0, 300)}`);
    return done.json();
  };
  const close = async () => {
    await context.storageState({ path: sessionFile }).catch(() => {});
    await browser.close();
  };
  return { browser, context, page, api, close };
}

/** Forks `parent` under `name` from the parent's page, unless it exists. */
async function forkFromPage(web, { origin }, parent, name, evidence) {
  const { page, api } = web;
  const mine = (await api('/api/v1/repos')).repos.find((r) => r.name === name);
  if (mine) return mine;
  await page.goto(`${origin}/source/${parent}`);
  await page.getByRole('button', { name: 'Fork' }).click();
  const form = page.getByRole('form', { name: 'Fork this repository' });
  await form.getByLabel('Fork name').fill(name);
  await form.getByRole('button', { name: 'Fork', exact: true }).click();
  // The new fork opens when done.
  await page.waitForURL((url) => !url.pathname.includes(parent), { timeout: 180_000 });
  await page.getByRole('button', { name: 'Add file' }).waitFor();
  await page.screenshot({ path: join(evidence, `${name}-forked.png`), fullPage: true });
  const made = (await api('/api/v1/repos')).repos.find((r) => r.name === name);
  assert.ok(made, `the fork ${name} is not listed after the form`);
  return made;
}

/** A repository's rules and agents, from the Settings and agent pages. */
export async function setUpRepository(web, { origin, evidence, parent, name, log }) {
  const { page, api, context } = web;
  const repo = await forkFromPage(web, { origin }, parent, name, evidence);
  const session = await api('/api/auth/session');
  const managed = `/api/managed/workspaces/${encodeURIComponent(session.username)}`;
  const state = await api(managed);
  const s = {
    context,
    page,
    name,
    origin,
    repo: repo.id,
    base: `/source/${repo.id}`,
    out: { problems: [] },
    defaultBlock: 'high',
    managed,
    agentsBefore: state.agents,
    reposByName: new Map(state.repos.map((r) => [r.name, r.id])),
    api,
    shot: (label) => page.screenshot({ path: join(evidence, `${name}-${label}.png`), fullPage: true }),
  };
  const status = await api(`/api/v1/repos/${repo.id}`);
  const set = status.landings?.land_when_cleared && status.landings?.agents && status.landings?.create;
  log(`${name}: ${set ? 'rules already on' : `rules ${await turnOnRules(s)}`}`);
  for (const agent of AGENTS) {
    const on = state.agents.find((a) => a.id === agent.id).enabled_repos.includes(repo.id);
    log(`${name}: ${agent.name}: ${on ? 'already on' : await addAgent(s, agent)}`);
    if (!on) s.agentsBefore = (await api(managed)).agents;
  }
  assert.deepEqual(s.out.problems, [], 'a save was refused');
  return { id: repo.id, name, base: s.base, managed };
}

/** One memory through the Memories page's form. */
export async function memoryFromPage(web, { origin, repo, kind, text, anchors, shot }) {
  const { page } = web;
  await page.goto(`${origin}/source/${repo}/agents/memories`);
  await page.getByRole('button', { name: 'Add a memory' }).click();
  const form = page.getByRole('form', { name: 'Add a memory' });
  await form.getByLabel('Kind').selectOption({ label: kind }).catch(async () => {
    await form.getByLabel('Kind').selectOption({ label: 'New kind…' });
    await form.getByLabel('Name the kind').fill(kind);
  });
  await form.getByLabel('Anchors').fill(anchors.join(', '));
  await form.getByLabel('What a later session should know').fill(text);
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  await form.getByRole('button', { name: 'Save memory' }).click();
  const refused = form.getByRole('alert');
  await Promise.race([form.waitFor({ state: 'detached' }), refused.waitFor()]);
  if (await refused.count()) throw new Error(`the form refused it: ${await refused.innerText()}`);
  await page.getByText(text.slice(0, 60)).first().waitFor();
}

export const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
