// Item 38 of the staging kit (no model): the Clone panel on a repository's Code tab, in Chrome. On
// a public repository it says nothing about tokens, and on a private one it points at Settings →
// Personal tokens. Copy puts exactly the shown command on the clipboard and says so. At phone
// width the panel fits the window, every command stays on one line and scrolls inside its own
// block, and the page never scrolls sideways.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';
import { kitRepo, openPage } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';

/** Narrowest first: the owner's phone rule is 375 px. */
const PHONES = [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 390, height: 844 }];
const TOKEN_LINK = 'Settings → Personal tokens';

async function openPanel(page, ctx, repo) {
  await openPage(page, ctx, repo);
  await page.locator('.clone-menu > summary').click();
  const panel = page.locator('.clone-dropdown');
  await see(panel.locator('.source-copy').first(), 'the clone commands');
  return panel;
}

/** What each repository's panel says about tokens, and that the command copies. */
async function tokenLine(page, ctx, repo, wanted, shot) {
  const panel = await openPanel(page, ctx, repo);
  await panel.getByRole('button', { name: 'Copy HTTPS' }).waitFor();
  const links = await panel.getByRole('link', { name: TOKEN_LINK }).count();
  assert.equal(links, wanted, `${repo.name}: ${links} token lines in the Clone panel, wanted ${wanted}`);
  if (!wanted) assert.doesNotMatch(await panel.innerText(), /token/i, `${repo.name}: a public clone speaks of tokens`);
  const copy = panel.getByRole('button', { name: 'Copy HTTPS' });
  const command = await panel.locator('.source-copy', { has: page.getByRole('button', { name: 'Copy HTTPS' }) }).locator('code').innerText();
  await copy.click();
  await see(copy.getByText('Copied'), 'Copied on the button');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command, 'the clipboard is not the shown command');
  await shot(`clone-${repo.visibility}`);
}

/** The panel inside the window with one line per command, and no sideways page. */
async function fits(page, ctx, repo, { width }, shot) {
  await page.setViewportSize(PHONES.find((v) => v.width === width));
  const panel = await openPanel(page, ctx, repo);
  const box = await panel.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= width, `at ${width} px the panel runs from ${box.x} to ${box.x + box.width}`);
  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    const lines = [...document.querySelectorAll('.clone-dropdown .source-copy pre')].map((pre) => ({
      high: pre.querySelector('code').getClientRects().length,
      spills: pre.getBoundingClientRect().right > root.clientWidth,
    }));
    return { sideways: root.scrollWidth > root.clientWidth, lines };
  });
  assert.equal(measured.sideways, false, `at ${width} px the page scrolls sideways`);
  assert.ok(measured.lines.every((l) => l.high === 1), `at ${width} px a command breaks over lines`);
  assert.ok(measured.lines.every((l) => !l.spills), `at ${width} px a command block runs past the window`);
  const copy = panel.getByRole('button', { name: 'Copy HTTPS' });
  const button = await copy.boundingBox();
  assert.ok(button.x + button.width <= width, `at ${width} px the Copy button is cut off`);
  await shot(`clone-phone-${width}`);
}

/** 38: both kinds of repository, wide and at phone width. */
export async function clonePanel(kit, { chrome, account }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const open = { ...(await kitRepo(kit, 'kit-clone-public', { visibility: 'public' })), visibility: 'public' };
  const closed = { ...(await kitRepo(kit, 'kit-clone-private')), visibility: 'private' };
  assert.equal((await kit.pat().get(open.path())).visibility, 'public', 'the repository was not created public');
  m.repo = `${open.id},${closed.id}`;
  const ctx = { origin: chrome.origin, account };
  await withChrome({ ...chrome, name: 'clone-panel', clipboard: true }, m, async ({ page, shot }) => {
    await tokenLine(page, ctx, open, 0, shot);
    await tokenLine(page, ctx, closed, 1, shot);
    for (const phone of PHONES) await fits(page, ctx, closed, phone, shot);
  });
  m.clone_panel = `public 0 token lines, private 1, Copy, phone ${PHONES.map((p) => p.width).join('/')}`;
}
