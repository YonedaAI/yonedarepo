// The pages of web-agents-flow.mjs: what a person clicks to create a repository, turn agents on and
// commit, and what the page and the API say afterwards. `s` holds the signed-in page and context,
// `api`, `shot`, the run's record `out` and what the flow learned so far.
import assert from 'node:assert/strict';

export const AGENTS = [
  { id: 'slop-review', name: 'Slop review', check: 'slop-review' },
  { id: 'intent-drift', name: 'Intent drift', check: 'intent-drift' },
];
/** Slop's own limit, 15 minutes, and a minute for the workflow to say so. */
const AGENT_MS = 16 * 60_000;
/** CTC's job after the last check. */
const LAND_MS = 3 * 60_000;
const TERMINAL = new Set(['passed', 'findings', 'failed', 'superseded', 'cancelled', 'paused']);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A run per agent on this head, once each has finished. */
async function runsOn(s, head) {
  const started = Date.now();
  for (;;) {
    const { runs } = await s.api(`${s.managed}/runs?repo=${s.repo}&limit=50`);
    const mine = AGENTS.map((a) => runs.find((r) => r.agent === a.id && r.head === head));
    if (mine.every((r) => r && TERMINAL.has(r.status))) return mine;
    if (Date.now() - started > AGENT_MS) {
      const said = mine.map((r, i) => `${AGENTS[i].id}:${r?.status ?? 'none'}`).join(' ');
      throw new Error(`runs on ${head.slice(0, 8)} unfinished after ${AGENT_MS / 60_000} min: ${said}`);
    }
    await sleep(5_000);
  }
}

/** Every run on the repository with its transcript and cost lines, before cleanup takes them. */
export async function keepRuns(s) {
  const { runs } = await s.api(`${s.managed}/runs?repo=${s.repo}&limit=50`);
  const kept = [];
  for (const run of runs) {
    const detail = await s.api(`${s.managed}/runs/${s.repo}/${encodeURIComponent(run.id)}`).catch((e) => ({ error: e.message }));
    kept.push({ run, transcript_tail: String(detail.transcript ?? '').slice(-4000), cost: detail.cost ?? null, error: detail.error ?? null });
  }
  return kept;
}

/** Stops the flow before it can pass the cap. */
export async function spentSoFar(s) {
  const { credit } = await s.api(s.managed);
  const spent = credit.used_usd - s.creditBefore.used_usd;
  s.out.spent_usd = Number(spent.toFixed(6));
  assert.ok(spent < s.capUsd * 0.8, `spent $${spent.toFixed(4)}, within 20% of the $${s.capUsd} cap`);
  return spent;
}

export async function createRepository(s) {
  await s.page.goto(`${s.origin}/repositories`);
  await s.page.getByRole('button', { name: 'New repository' }).first().click();
  await s.page.getByRole('menuitem', { name: 'Create repository' }).click();
  const dialog = s.page.getByRole('dialog', { name: 'New repository' });
  await dialog.getByLabel('Repository name').fill(s.name);
  await s.shot('new-repository');
  await dialog.getByRole('button', { name: 'Create repository' }).click();
  await s.page.waitForURL(/\/source\/r[0-9a-f]{20}|\/[^/]+\/[^/]+$/);
  await s.page.getByRole('button', { name: 'Add file' }).waitFor();
  s.repo = (await s.api('/api/v1/repos')).repos.find((r) => r.name === s.name).id;
  s.base = `/source/${s.repo}`;
  s.out.repo = s.repo;
  await s.shot('repository');
  return s.repo;
}

export async function turnOnRules(s) {
  const { page } = s;
  await page.goto(`${s.origin}${s.base}/settings`);
  await page.getByLabel('Approvals needed to land on main').fill('0');
  await page.getByLabel('Required checks').fill(AGENTS.map((a) => a.check).join('\n'));
  await page.getByRole('button', { name: /^Save / }).first().click();
  await page.getByText(/^Saved\./).waitFor();
  for (const name of ['Open a Landing for every pushed branch', 'Run agents on automatic Landings', 'Land when cleared']) {
    // Each saves at once, and the box follows the server's answer.
    await page.getByRole('checkbox', { name }).click();
    await page.waitForFunction((n) => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes(n));
      return label?.querySelector('input')?.checked && !label.closest('fieldset').disabled;
    }, name);
  }
  await s.shot('landing-rules');
  const status = await s.api(`/api/v1/repos/${s.repo}`);
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
export async function addAgent(s, agent, block) {
  const { page } = s;
  const before = s.agentsBefore.find((a) => a.id === agent.id);
  const allowed = new Set([...before.enabled_repos, s.repo]);
  await page.route(`**/api/managed/workspaces/*/agents/${agent.id}`, (route) => {
    const body = route.request().postDataJSON();
    const named = body?.repos ?? [];
    // A second save names no repositories at all, and then touches none.
    const safe = !body?.all_repos && named.every((r) => allowed.has(r)) && (body?.repos === undefined || named.includes(s.repo));
    if (!safe) s.out.problems.push(`refused a save naming ${named.length} repositories, all_repos=${body?.all_repos}`);
    return safe ? route.continue() : route.abort();
  });
  await page.goto(`${s.origin}/agents/${agent.id}/configure`);
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
  // Left alone, the form shows what the agent does with nothing chosen.
  const level = page.getByLabel('Block landing at');
  if (block === undefined) assert.equal(await level.inputValue(), s.defaultBlock, 'the level the form starts on');
  else await level.selectOption(block);
  await s.shot(`add-${agent.id}`);
  await page.getByRole('button', { name: /^(Add agent|Save changes)$/ }).click();
  await page.waitForURL(new RegExp(`/agents/${agent.id}(\\?|$)|/agents/${agent.id}/configure`));
  await sleep(1500);
  await page.unroute(`**/api/managed/workspaces/*/agents/${agent.id}`);
  const state = (await s.api(s.managed)).agents.find((a) => a.id === agent.id);
  assert.ok(state.enabled_repos.includes(s.repo), `${agent.id} is not on the repository`);
  assert.equal(state.settings.block_at, block === undefined ? s.defaultBlock : block || null, 'the level read back');
  await s.shot(`agent-${agent.id}`);
  return `on, block ${block === undefined ? `${s.defaultBlock} (default)` : block || 'never'}, model ${state.settings.provider}/${state.settings.model}`;
}

/** The Files page's form, filled as a person would, on the branch or file `at` points to. */
export async function commitFromPage(s, c, { at = '', edit = false } = {}) {
  const { page } = s;
  await page.goto(`${s.origin}${s.base}${at}`);
  await page.getByRole('button', { name: edit ? 'Edit' : 'Add file' }).click();
  const form = page.getByRole('form', { name: edit ? `Edit ${c.path}` : 'Add a file' });
  if (!edit) await form.getByLabel('File').fill(c.path);
  await form.getByLabel('Contents').fill(c.content);
  await form.getByLabel('Commit message').fill(c.message);
  if (c.branch) await form.getByLabel('Branch').fill(c.branch);
  if (c.goal) await form.getByLabel('Flight plan').fill(c.goal);
  await s.shot(`${c.id}-form`);
  await form.getByRole('button', { name: 'Commit' }).click();
  await page.waitForURL(/\/changes\/\d+$/, { timeout: 30_000 });
  const number = Number(page.url().match(/(\d+)$/)[1]);
  await page.getByRole('heading', { level: 2, name: c.landing ?? c.message }).waitFor();
  await s.shot(`${c.id}-landing-opened`);
  return number;
}

/** Waits on the open page, never reloading it: what a person sees is what the test sees. */
export async function pageShows(s, c, number) {
  const { page } = s;
  const started = Date.now();
  const cards = page.locator('.source-instruments');
  await cards.getByText(/Slop/).waitFor({ timeout: AGENT_MS });
  // No plan, no reading: the check passes and there is no card to wait for.
  if (c.goal !== '') await cards.getByText(/Intent drift/).waitFor({ timeout: AGENT_MS });
  await page.waitForFunction(() => !document.querySelector('.source-instruments')?.textContent.includes('Not reviewed yet'), null, { timeout: AGENT_MS });
  const shownS = Math.round((Date.now() - started) / 1000);
  await s.shot(`${c.id}-instruments`);
  // Every state the chip shows, in order: a flash is a finding, not an outcome. Go-around has to
  // stand for a full polling beat, Landed ends it.
  const chip = page.locator('.source-change header .source-change-status');
  const states = [];
  const until = Date.now() + LAND_MS;
  let since = Date.now();
  for (;;) {
    const now = (await chip.innerText()).trim();
    if (states.at(-1) !== now) {
      states.push(now);
      since = Date.now();
    }
    if (now === 'Landed' || (now === 'Go-around' && Date.now() - since > 25_000) || Date.now() > until) break;
    await sleep(1000);
  }
  const state = states.at(-1);
  await s.shot(`${c.id}-landing-final`);
  return { shownS, state, states, text: (await cards.innerText()).replace(/\s+/g, ' ').slice(0, 300), number };
}

/** The API's word on it, to hold the page to. */
export async function facts(s, number, head) {
  const [slop, drift] = await runsOn(s, head);
  const change = await s.api(`/api/v1/repos/${s.repo}/changes/${number}`);
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

/** Break-glass, as the Settings page sends it. */
export const pauseAutomation = (s, action) =>
  s.api(`/api/v1/repos/${s.repo}/break-glass`, { method: 'POST', data: { action, reason: 'web agents flow: a pause and its resume' } });

/** Time for a run that must not start to have started: a hook, a queue job and a workflow. */
const PAUSE_WATCH_MS = 45_000;

/** Nothing ran on `head` and nothing failed, while automation is paused. */
export async function nothingDuringPause(s, number, head) {
  await sleep(PAUSE_WATCH_MS);
  const { runs } = await s.api(`${s.managed}/runs?repo=${s.repo}&limit=50`);
  assert.deepEqual(runs.filter((r) => r.head === head).map((r) => r.agent), [], 'a run started during the pause');
  const change = await s.api(`/api/v1/repos/${s.repo}/changes/${number}`);
  assert.deepEqual(change.head_commit?.checks ?? [], [], 'a check was posted during the pause');
  assert.equal(change.status, 'open');
  return `no run and no check after ${PAUSE_WATCH_MS / 1000} s`;
}

export async function ctcPage(s, label) {
  await s.page.goto(`${s.origin}${s.base}/tower`);
  await s.page.getByRole('heading', { name: 'Tower', exact: true }).first().waitFor();
  await sleep(1000);
  await s.shot(`${label}-ctc`);
  return (await s.page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 400);
}

/** The commit form against the UI rules: wide and 375 px, light and dark, its error, the
 * keyboard, and no sideways scroll on the page. Nothing here commits. */
export async function lookAtForm(s) {
  const { page } = s;
  const seen = [];
  const form = page.getByRole('form', { name: 'Add a file' });
  for (const [label, width] of [['wide', 1440], ['phone', 375]])
    for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await page.goto(`${s.origin}${s.base}`);
      await page.getByRole('button', { name: 'Add file' }).click();
      await form.waitFor();
      await form.getByLabel('File').fill('src/a.js');
      await form.getByLabel('Branch').fill('main');
      await form.getByRole('button', { name: 'Commit' }).click();
      await form.getByText(/Main moves only by landing/).waitFor();
      await s.shot(`form-${label}-${colorScheme}`);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(sideways <= 0, `${label} ${colorScheme}: the page scrolls sideways by ${sideways}px`);
      seen.push(`${label} ${colorScheme}`);
    }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Add file' }).focus();
  await page.keyboard.press('Enter');
  await form.waitFor();
  const focused = await page.evaluate(() => document.activeElement?.closest('label')?.textContent?.trim());
  assert.equal(focused, 'File', 'the keyboard lands on the first field');
  await page.keyboard.press('Escape');
  return `${seen.join(', ')}; Escape closes, Enter opens on File`;
}

export async function restore(s) {
  for (const before of s.agentsBefore) {
    if (!AGENTS.some((a) => a.id === before.id)) continue;
    const body = {
      repos: before.enabled_repos,
      ...(before.all_repos ? { all_repos: true } : {}),
      settings: { block_at: before.settings.block_at },
    };
    await s.api(`${s.managed}/agents/${before.id}`, { method: 'PUT', data: body });
  }
  const after = (await s.api(s.managed)).agents;
  return after.filter((a) => AGENTS.some((b) => b.id === a.id)).map((a) => `${a.id}: ${a.enabled_repos.length} repos, block ${a.settings.block_at}`).join('; ');
}

