// Browser gate, agent pages (part of kit item `browser`): one session is recorded on main's
// head by API (as the Yoneda plugin or `yoneda session record` would), then the Sessions page
// lists it, the CLI filter keeps it, its page shows the summary, commit and declared reads,
// and the commit page links back to it and, main's head having landed, shows only where it
// landed and Revert. Memories, then Agent tools and its Contracts, Kept commits and Find a
// breaking commit tabs show their empty states (the kit records none). On every page the
// sidebar highlights exactly one entry: that page's.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { missingText } from './agent-tools-plan.mjs';
import { see } from './browser-collab-flow.mjs';
import { sleep } from './client.mjs';

/** The Repository navigation's highlighted entries (exactly one on every repository page). */
export const highlighted = (page) =>
  page.getByRole('navigation', { name: 'Repository' }).locator('a[aria-current="page"]').allInnerTexts();

async function onlyHighlighted(page, entry) {
  for (const deadline = Date.now() + 10_000; ; await sleep(200)) {
    const shown = (await highlighted(page)).map((t) => t.trim());
    if (shown.length === 1 && shown[0] === entry) return;
    if (Date.now() > deadline) assert.deepEqual(shown, [entry], `the sidebar highlights ${entry} only`);
  }
}

export async function agentPages(page, { account, repo: { id, name }, shot }, m) {
  const api = (path) => `/api/v1/repos/${id}${path}`;
  const main = (await account.get(api('/refs'))).refs['refs/heads/main'];
  const summary = `Browser gate session ${Date.now()}: kept the parser on config v2.`;
  const posted = await account.post(api(`/commits/${main}/sessions`), {
    cli: 'opencode',
    model: 'glm-kit',
    summary,
    transcript_ref: 'opencode:browser-gate',
  });
  m.agent_session = posted.session;

  const tabs = page.getByRole('navigation', { name: 'Repository' });
  await page.getByRole('navigation', { name: 'Repositories' }).getByRole('link', { name, exact: true }).click();
  await page.waitForURL(`**/source/${id}`);
  await tabs.getByRole('link', { name: 'Sessions' }).click();
  await page.waitForURL(`**/source/${id}/agents`);
  await onlyHighlighted(page, 'Sessions');
  assert.equal(await page.getByRole('navigation', { name: 'Agent tools' }).count(), 0, 'Sessions shows the Agent tools tabs');
  const list = page.getByRole('list', { name: 'Sessions' });
  const row = list.getByRole('listitem').filter({ hasText: summary });
  await see(row, 'the recorded session in the Sessions list');
  await see(row.getByText(main.slice(0, 10)), "the session's commit");
  await shot('agents-sessions');
  await page.getByLabel('CLI', { exact: true }).selectOption('opencode');
  await see(list.getByRole('listitem').filter({ hasText: summary }), 'the session under the opencode filter');

  await row.getByRole('link', { name: new RegExp(summary.slice(0, 30)) }).click();
  await page.waitForURL(`**/source/${id}/agents/sessions/${posted.session}`);
  await onlyHighlighted(page, 'Sessions');
  const detail = page.locator('article.agent-session');
  await see(detail.getByRole('heading', { name: /opencode/ }), 'the session page heading');
  await see(detail.getByText(summary), 'the session summary');
  await see(detail.getByRole('heading', { name: /^Files read/ }), "the session's declared reads");
  await shot('agents-session');

  await detail.getByRole('link', { name: new RegExp(main.slice(0, 10)) }).first().click();
  await page.waitForURL(`**/source/${id}/commit/${main}`);
  const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
  await see(sessions.getByRole('link', { name: /opencode/ }), 'the session link on the commit page');
  await shot('agents-commit-sessions');

  // main's head has landed: the panel says where, when and by whom, and offers Revert only.
  const gates = page.getByRole('region', { name: 'Landing gates' });
  await see(gates.getByText(/^Landed on main at v\d+ · .+ · by \S+/), 'the landed line on a landed commit');
  await see(gates.getByRole('button', { name: 'Revert' }), 'Revert on a landed commit');
  for (const name of ['Approve', 'Reject', /^Land/, 'Break glass…'])
    assert.equal(await gates.getByRole('button', { name }).count(), 0, `a landed commit offers ${name}`);
  assert.equal(await gates.locator('summary', { hasText: 'More' }).count(), 0, 'a landed commit has a More menu');
  assert.equal(await gates.getByRole('combobox').count(), 0, 'a landed commit offers a branch to land on');
  assert.equal(await gates.getByText(/Ready to land|Review class|Approvals \d+\/\d+/).count(), 0, 'a landed commit shows landing gates');
  m.landed_commit_panel = 'landed line, Revert only';

  await tabs.getByRole('link', { name: 'Memories', exact: true }).click();
  await page.waitForURL(`**/source/${id}/agents/memories`);
  await onlyHighlighted(page, 'Memories');
  assert.equal(await page.getByRole('navigation', { name: 'Agent tools' }).count(), 0, 'Memories shows the Agent tools tabs');
  await shot('agents-memories');

  await tabs.getByRole('link', { name: 'Agent tools', exact: true }).click();
  await page.waitForURL(`**/source/${id}/agents/contracts`);
  const tools = page.getByRole('navigation', { name: 'Agent tools' });
  assert.deepEqual(
    (await tools.getByRole('link').allInnerTexts()).map((t) => t.trim()),
    ['Contracts', 'Kept commits', 'Find a breaking commit'],
    'the Agent tools tabs',
  );
  for (const [tab, section, empty] of [
    ['Contracts', 'contracts', /^No contracts yet\./],
    ['Kept commits', 'pins', /^No kept commits\./],
    ['Find a breaking commit', 'bisects', /^No searches yet\./],
  ]) {
    await tools.getByRole('link', { name: tab, exact: true }).click();
    await page.waitForURL(`**/source/${id}/agents/${section}`);
    await see(page.getByText(empty), `the ${section} empty state`);
    await onlyHighlighted(page, 'Agent tools');
  }
  m.agent_nav = 'one highlighted entry per page';
  await shot('agents-bisects-empty');
  assert.ok(m.agent_session > 0, 'the session was recorded');
}

/**
 * Kit item 30.6's browser half (realuser-agent-tools.mjs): with the run's own signed-in
 * session (`cookie`, no second sign-in), the Agent tools tabs of `repo` show the rows the run
 * made, with Agent tools the one highlighted sidebar entry: `expect` maps a section route
 * (contracts, pins, bisects) to the texts its page must contain. Sections are opened by route.
 */
export async function agentToolPages({ origin, cookie, repo, expect, dir, headed = false }, m) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const [name, ...value] = cookie.split('=');
    await context.addCookies([{ name, value: value.join('='), url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    for (const [section, texts] of Object.entries(expect)) {
      await page.goto(new URL(`/source/${repo}/agents/${section}`, origin).href);
      await onlyHighlighted(page, 'Agent tools');
      let missing = texts;
      for (const deadline = Date.now() + 30_000; missing.length && Date.now() < deadline; await sleep(1000))
        missing = missingText(await page.locator('body').innerText().catch(() => ''), texts);
      await page.screenshot({ path: join(dir, `agent-tools-${section}.png`), fullPage: true });
      assert.deepEqual(missing, [], `the ${section} page lacks ${missing.join(', ')}`);
      m[`browser_${section}`] = 'rows shown';
    }
  } finally {
    await browser.close();
  }
}
