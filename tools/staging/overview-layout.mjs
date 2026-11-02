// Browser QA for Overview: resolved activity and contributors must not reserve an empty chart.
// Loading keeps its space; once settled, the README follows the visible content.
import assert from 'node:assert/strict';

export function measureOverview() {
  const root = document.querySelector('.repo-overview');
  const numbers = root?.querySelector('.overview-numbers');
  const readme = root?.querySelector('.readme');
  if (!numbers || !readme || numbers.querySelector('[aria-busy=true]')) return null;
  const visible = [...numbers.children].filter((el) => el.getBoundingClientRect().height > 0);
  if (!visible.length) return null;
  const bottom = Math.max(...visible.map((el) => el.getBoundingClientRect().bottom));
  return { gap: Math.round(readme.getBoundingClientRect().top - bottom) };
}

export async function checkOverviewLayout(page) {
  const measured = await page.evaluate(measureOverview);
  if (measured) assert.ok(measured.gap <= 32, `Overview leaves ${measured.gap}px before the README`);
  return measured;
}

/** Same served app, with a labelled old-history response; no repository data is changed. */
export async function overviewStates(page, { repo, shot }) {
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Overview', exact: true }).click();
  await page.locator('.readme').waitFor();
  await page.locator('.overview-numbers [aria-busy=true]').waitFor({ state: 'detached' });
  await checkOverviewLayout(page);
  const logs = (url) => url.pathname === `/api/v1/repos/${repo}/log`;
  await page.route(logs, async (route) => {
    const reply = await route.fetch();
    const data = await reply.json();
    const commits = data.commits.map((c) => ({ ...c, authored_at: 1000, landed: { ...c.landed, landed_at: 1000 } }));
    await route.fulfill({ response: reply, json: { ...data, commits } });
  });
  try {
    await page.reload();
    await page.getByText('No commits in the past month.', { exact: true }).waitFor();
    await page.locator('.readme').waitFor();
    for (const width of [1440, 375])
      for (const colorScheme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme });
        await checkOverviewLayout(page);
        await shot(`overview-old-history-fixture-${width}-${colorScheme}`);
      }
  } finally {
    await page.unroute(logs);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await page.locator('.readme').waitFor();
  }
}
