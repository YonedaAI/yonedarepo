// Item 35's second half: a Landing's state, worked out from its data and never stored, and the
// rename, on real pages. A title marked Draft reads Planned; open and unjudged, In flight; a head
// the second kit account approved, Cleared to land; one it rejected, Go-around; then Landed and
// Closed. The list reads no gates, so it says only In flight. The tab says Landings, `/landings`
// is the same page as `/changes`, the panel says Clearance, and no page says pull request.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';
import { cloneOf, kitRepo, openPage, pushWork } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';

const CHIP = '.source-change-status';

/** The state on `number`'s page once its gates have answered; `want` is the state expected. */
async function pageSays(page, ctx, repo, number, want) {
  await openPage(page, ctx, repo, `/changes/${number}`);
  await page.getByRole('heading', { level: 2 }).first().waitFor();
  await page.locator('article.source-change header').locator(CHIP).getByText(want, { exact: true }).waitFor({ timeout: 20_000 }).catch(async () => {
    const shown = await page.locator('article.source-change header').locator(CHIP).first().innerText().catch(() => 'nothing');
    throw new Error(`Landing ${number} reads ${shown}, not ${want}`);
  });
}

async function renamed(page, ctx, repo, number, m) {
  const tabs = page.getByRole('navigation', { name: 'Repository' });
  await openPage(page, ctx, repo, '/landings');
  await see(page.getByRole('heading', { level: 2, name: 'Landings', exact: true }), 'the Landings heading at /landings');
  await see(page.getByRole('link', { name: new RegExp(`#${number}$`) }), 'the same list at /landings');
  await see(tabs.getByRole('link', { name: 'Landings', exact: true }), 'the Landings tab');
  assert.equal(await tabs.getByRole('link', { name: /^(Changes|Pull requests)$/ }).count(), 0, 'the tab keeps an old name');
  await openPage(page, ctx, repo, '/changes');
  await see(page.getByRole('heading', { level: 2, name: 'Landings', exact: true }), 'the Landings heading at /changes');
  await page.getByRole('link', { name: new RegExp(`#${number}$`) }).click();
  await see(page.getByRole('button', { name: '← All Landings' }), 'the way back to All Landings');
  await see(page.getByRole('region', { name: 'Clearance', exact: true }), 'the Clearance panel');
  const text = await page.locator('main').innerText();
  assert.doesNotMatch(text, /pull request|merge request|change request/i, 'a Landing page uses an old name');
  m.rename = 'tab,/landings,/changes,back link,Clearance';
}

/** Runs the states on a repository that asks for one approval, which the kit's second account
 * gives: nobody reviews their own commit. */
export async function landingStates(kit, { chrome, account, credentials }, m) {
  const api = kit.pat();
  const repo = await kitRepo(kit, 'kit-states', { approvals: 1 });
  const dir = await cloneOf(kit, repo, 'states');
  const reviewer = await credentials.second();
  await api.post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  const review = (head, decision, reason) => reviewer.session.post(repo.path(`/commits/${head}/reviews`), { decision, reason });
  const work = async (branch, title, file) => {
    const head = await pushWork(kit, dir, { branch, message: title, files: { [file]: `export const x = '${branch}';\n` } });
    const { number } = await api.post(repo.path('/changes'), { branch, title });
    return { head, number };
  };
  const planned = await work('kit/draft', 'Draft: not ready', 'src/draft.ts');
  const flying = await work('kit/flying', 'Still flying', 'src/flying.ts');
  const cleared = await work('kit/cleared', 'Ready to land', 'src/cleared.ts');
  const around = await work('kit/around', 'Sent back', 'src/around.ts');
  const landing = await work('kit/landing', 'Lands now', 'src/landing.ts');
  const closing = await work('kit/closing', 'Closes now', 'src/closing.ts');
  await review(cleared.head, 'approve');
  await review(around.head, 'reject', 'Not this way');
  await review(landing.head, 'approve');
  await api.post(repo.path('/land'), { ref: 'main', commit: landing.head });
  await api.post(repo.path(`/changes/${closing.number}/close`));

  const ctx = { origin: chrome.origin, account };
  await withChrome({ ...chrome, name: 'landings-states' }, m, async ({ page, shot }) => {
    await openPage(page, ctx, repo, '/changes');
    const list = page.getByRole('list', { name: 'open Landings' });
    const chip = (title) => list.getByRole('listitem').filter({ hasText: title }).locator(CHIP);
    await see(chip('not ready').getByText('Planned', { exact: true }), 'Planned in the list');
    for (const title of ['Still flying', 'Ready to land', 'Sent back']) await see(chip(title).getByText('In flight', { exact: true }), `In flight for ${title} in the list`);
    await shot('states-list');
    const pages = [
      [planned.number, 'Planned'],
      [flying.number, 'In flight'],
      [cleared.number, 'Cleared to land'],
      [around.number, 'Go-around'],
      [landing.number, 'Landed'],
      [closing.number, 'Closed'],
    ];
    for (const [number, want] of pages) {
      await pageSays(page, ctx, repo, number, want);
      await shot(`state-${want.toLowerCase().replaceAll(' ', '-')}`);
    }
    await pageSays(page, ctx, repo, around.number, 'Go-around');
    await see(page.getByRole('region', { name: 'Clearance', exact: true }).getByText(`Rejected by ${reviewer.name}: Not this way`), 'who rejected it, as people read it');
    m.states = pages.map(([, state]) => state).join(',');
    await renamed(page, ctx, repo, flying.number, m);
  });
}
