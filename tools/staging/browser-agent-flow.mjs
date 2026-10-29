// Browser gate, agent pages (part of kit item `browser`): one session is recorded on main's
// head by API (as the Yoneda plugin or `yoneda session record` would), then the Agents tab
// lists it, the CLI filter keeps it, its page shows the summary, commit and declared reads,
// and the commit page links back to it and, main's head having landed, shows only where it
// landed and Revert. The Contracts, Pins and Bisects sections show their
// empty states (the kit records none).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { missingText } from './agent-tools-plan.mjs';
import { see } from './browser-collab-flow.mjs';
import { sleep } from './client.mjs';

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
  await tabs.getByRole('link', { name: 'Agents' }).click();
  await page.waitForURL(`**/source/${id}/agents`);
  const list = page.getByRole('list', { name: 'Sessions' });
  const row = list.getByRole('listitem').filter({ hasText: summary });
  await see(row, 'the recorded session in the Sessions list');
  await see(row.getByText(main.slice(0, 10)), "the session's commit");
  await shot('agents-sessions');
  await page.getByLabel('CLI', { exact: true }).selectOption('opencode');
  await see(list.getByRole('listitem').filter({ hasText: summary }), 'the session under the opencode filter');

  await row.getByRole('link', { name: new RegExp(summary.slice(0, 30)) }).click();
  await page.waitForURL(`**/source/${id}/agents/sessions/${posted.session}`);
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

  for (const [section, empty] of [
    ['contracts', /^No contracts recorded yet\./],
    ['pins', /^No pinned commits\./],
    ['bisects', /^No bisects yet\./],
  ]) {
    await page.goto(new URL(`/source/${id}/agents/${section}`, page.url()).href);
    await see(page.getByText(empty), `the ${section} empty state`);
  }
  await shot('agents-bisects-empty');
  assert.ok(m.agent_session > 0, 'the session was recorded');
}

/**
 * Kit item 30.6's browser half (realuser-agent-tools.mjs): with the run's own signed-in
 * session (`cookie`, no second sign-in), the Agents sections of `repo` show the rows the run
 * made: `expect` maps a section route (contracts, pins, bisects) to the texts its page must
 * contain. Sections are opened by route, not by tab label (the labels are being renamed).
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
