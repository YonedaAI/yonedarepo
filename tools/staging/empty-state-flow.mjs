// Item 42 of the staging kit (no model): the shared empty state on a repository with nothing in it,
// on Sessions, Landings (each filter) and CTC, wide and at 375 px, as the UI rules set it: one
// centred title, one or two plain sentences, at most one action, no box, no command syntax, no
// table over no rows and no intro line above it.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';
import { kitRepo, openPage } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';

const PHONE = { width: 375, height: 812 };
const PAGES = [
  { rest: '/agents', title: 'No sessions yet' },
  { rest: '/changes', title: 'No open Landings' },
  { rest: '/changes', filter: 'Landed', title: 'Nothing has landed yet' },
  { rest: '/changes', filter: 'Closed', title: 'No closed Landings' },
  { rest: '/changes', filter: 'All', title: 'No Landings yet' },
  { rest: '/tower', title: 'Nothing on the radar' },
];

/** The rules, read from what the browser laid out. */
async function ruled(page, { title, rest }, width) {
  const what = `${title} at ${rest}, ${width} px`;
  const empty = page.locator('.empty-state');
  await see(empty.getByRole('heading', { name: title, exact: true }), what);
  assert.equal(await empty.count(), 1, `${what}: more than one empty state`);
  const shown = await empty.evaluate((node) => {
    const style = getComputedStyle(node);
    const main = node.closest('section').getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      align: style.textAlign,
      border: style.borderTopWidth,
      background: style.backgroundColor,
      code: node.querySelectorAll('code, pre').length,
      paragraphs: node.querySelectorAll('p').length,
      actions: node.querySelectorAll('a, button').length,
      offset: Math.abs((box.left + box.right) / 2 - (main.left + main.right) / 2),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  assert.equal(shown.align, 'center', `${what}: the title is not centred`);
  assert.equal(shown.border, '0px', `${what}: a box around it`);
  assert.equal(shown.code, 0, `${what}: command syntax in it`);
  assert.ok(shown.paragraphs <= 1, `${what}: more than one paragraph`);
  assert.ok(shown.actions <= 1, `${what}: more than one action`);
  assert.ok(shown.offset <= 1, `${what}: not centred on its section, ${shown.offset} px off`);
  assert.equal(shown.sideways, false, `${what}: the page scrolls sideways`);
  assert.equal(await page.getByRole('table').count(), 0, `${what}: a table over no rows`);
}

/** 42: `chrome` and `account` for the pages. */
export async function emptyStates(kit, { chrome, account }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const repo = await kitRepo(kit, 'kit-empty');
  m.repo = repo.id;
  const ctx = { origin: chrome.origin, account };
  await withChrome({ ...chrome, name: 'empty-states' }, m, async ({ page, shot }) => {
    for (const size of [{ width: 1440, height: 1000 }, PHONE]) {
      await page.setViewportSize(size);
      for (const entry of PAGES) {
        await openPage(page, ctx, repo, entry.rest);
        if (entry.filter) await page.getByRole('button', { name: entry.filter, exact: true }).click();
        await ruled(page, entry, size.width);
        await shot(`empty-${entry.rest.slice(1)}-${entry.filter ?? 'open'}-${size.width}`);
      }
    }
    await openPage(page, ctx, repo, '/tower');
    await see(page.locator('.empty-state').getByRole('heading', { name: 'Nothing on the radar' }), 'the Tower empty state');
    assert.equal(await page.getByText('What is cleared, what is waiting').count(), 0, 'Tower keeps its intro line over nothing');
    assert.equal(await page.getByText('Land when cleared is off').count(), 0, 'Tower explains a switch with nothing to show');
  });
  m.empty_pages = PAGES.length * 2;
}
