// Item 35 of the staging kit (no model): Landings for every push. Off by default, a pushed branch
// opens nothing. "Open a Landing for every pushed branch" in Settings → Landing rules turns it on
// for this repository only: a pushed branch gets an automatic Landing, moves with its pushes, and
// main, release branches and a branch already on main get none. `yoneda change create` adopts the
// row, and a second create is refused. A closed Landing stays closed through a push; a landed
// branch pushed again gets a new one. A push straight to main lists as "Landed directly".
// The computed states follow (landings-state-flow.mjs).
import assert from 'node:assert/strict';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { cloneOf, kitRepo, openPage, pushWork, refusal, settled } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';
import { landingStates } from './landings-state-flow.mjs';

const SWITCH = 'Open a Landing for every pushed branch';
const landingsOf = async (kit, repo, status = 'open') => (await kit.pat().get(repo.path(`/changes?status=${status}`))).changes;
const onBranch = async (kit, repo, branch, status = 'open') => (await landingsOf(kit, repo, status)).filter((c) => c.branch === branch);

/** Off: a push opens nothing. Settings turns it on, here and nowhere else. */
async function switchOn(kit, repo, dir, { chrome, account }, m) {
  const api = kit.pat();
  assert.deepEqual((await api.get(repo.path())).landings, { create: false, agents: false, land_when_cleared: false, findings_block: false }, 'a new repository has every switch off');
  await pushWork(kit, dir, { branch: 'kit/off', message: 'Before the switch', files: { 'src/off.ts': 'export const off = 1;\n' } });
  assert.deepEqual(await landingsOf(kit, repo), [], 'a push opened a Landing with the switch off');
  await withChrome({ ...chrome, name: 'landings' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: chrome.origin, account }, repo, '/settings');
    await see(page.getByRole('heading', { name: 'Automatic Landings' }), 'Automatic Landings in Landing rules');
    const box = page.getByRole('checkbox', { name: SWITCH });
    const agents = page.getByRole('checkbox', { name: 'Run agents on automatic Landings' });
    assert.ok(await agents.isDisabled(), 'agents on automatic Landings can be turned on with Landings off');
    // It shows what the server saved, so it changes when the save answers, not on the click.
    await box.click();
    await settled(() => box.isChecked(), 'the switch to read saved');
    await settled(async () => !(await agents.isDisabled()), 'the agents switch to open up');
    await shot('landings-switch-on');
  });
  const { landings } = await api.get(repo.path());
  assert.deepEqual(landings, { create: true, agents: false, land_when_cleared: false, findings_block: false }, 'the switch in Settings is not what the API reads');
}

/** A pushed branch gets one, which follows it; main, release and a head on main get none. */
async function perPush(kit, repo, dir, m) {
  const head = await pushWork(kit, dir, { branch: 'kit/auto', message: 'Auto one', files: { 'src/auto.ts': 'export const auto = 1;\n' } });
  const [row] = await onBranch(kit, repo, 'kit/auto');
  assert.ok(row, 'a pushed branch got no Landing');
  assert.deepEqual([row.origin, row.title, row.head], ['auto', 'Auto one', head], 'the automatic Landing');
  const next = await pushWork(kit, dir, { branch: 'kit/auto', from: null, message: 'Auto two', files: { 'src/auto.ts': 'export const auto = 2;\n' } });
  const moved = await onBranch(kit, repo, 'kit/auto');
  assert.deepEqual(moved.map((c) => [c.number, c.head]), [[row.number, next]], 'a second push made another row or left the head behind');

  await pushWork(kit, dir, { branch: 'release-1', message: 'A release', files: { 'src/release.ts': 'export const r = 1;\n' } });
  await kit.gitOk(dir, 'switch', '-q', '-C', 'kit/on-main', 'origin/main');
  await kit.ok('git', ['push', '-q', 'origin', 'HEAD:refs/heads/kit/on-main'], { cwd: dir, env: kit.env(NO_SESSION) });
  await pushWork(kit, dir, { branch: 'main', message: 'Straight to main', files: { 'src/main.ts': 'export const m = 1;\n' } });
  const open = await landingsOf(kit, repo);
  assert.deepEqual(open.map((c) => c.branch), ['kit/auto'], 'main, a release branch or a branch on main got a Landing');
  m.auto_landing = row.number;
  return row.number;
}

/** `yoneda change create` claims the row; a second create is refused. */
async function adoption(kit, repo, dir, number, m) {
  await kit.gitOk(dir, 'switch', '-q', 'kit/auto');
  const opened = await kit.yonedaOk(['change', 'create', '-m', 'Adopted by the CLI'], { cwd: dir, env: kit.env(NO_SESSION) });
  assert.match(opened.stdout, new RegExp(`#${number} \\[open\\]`), `adoption answered another change: ${opened.stdout}`);
  const [row] = await onBranch(kit, repo, 'kit/auto');
  assert.deepEqual([row.number, row.origin], [number, 'explicit'], 'the row was not claimed');
  const again = await kit.pat().raw('POST', repo.path('/changes'), { branch: 'kit/auto', title: 'Twice' });
  assert.ok(again.status >= 400, `a second create on an explicit row: ${again.status}`);
  m.adopted = `#${number}, again ${refusal(again)}`;
}

/** Closed stays closed through a push; landed and pushed again gets a new row. */
async function afterwards(kit, repo, dir, number, m) {
  const api = kit.pat();
  await api.post(repo.path(`/changes/${number}/close`));
  await pushWork(kit, dir, { branch: 'kit/auto', from: null, message: 'After closing', files: { 'src/auto.ts': 'export const auto = 3;\n' } });
  assert.deepEqual(await onBranch(kit, repo, 'kit/auto'), [], 'a push reopened a closed Landing');

  const first = await pushWork(kit, dir, { branch: 'kit/twice', message: 'Lands once', files: { 'src/twice.ts': 'export const t = 1;\n' } });
  const [row] = await onBranch(kit, repo, 'kit/twice');
  await settled(async () => (await api.get(repo.path(`/changes/${row.number}`))).head === first, 'the Landing at its head');
  const landed = await api.post(repo.path('/land'), { ref: 'main', commit: first });
  assert.ok(Number.isInteger(landed.version ?? landed.landed_version), `the landing: ${JSON.stringify(landed).slice(0, 200)}`);
  await settled(async () => (await api.get(repo.path(`/changes/${row.number}`))).status === 'landed', 'the Landing to read landed');
  const second = await pushWork(kit, dir, { branch: 'kit/twice', from: null, message: 'Lands twice', files: { 'src/twice.ts': 'export const t = 2;\n' } });
  const fresh = await onBranch(kit, repo, 'kit/twice');
  assert.equal(fresh.length, 1, 'a landed branch pushed again got no new row');
  assert.notEqual(fresh[0].number, row.number, 'a landed row came back');
  assert.equal(fresh[0].head, second, 'the new row is not at the push');
  m.landed_then_new = `#${row.number} → #${fresh[0].number}`;
}

/** Listed direct landings: what reached main with no Landing naming it. */
async function direct(kit, repo, { chrome, account }, m) {
  const { direct: rows = [] } = await kit.pat().get(repo.path('/changes?status=landed&direct=1'));
  const row = rows.find((d) => d.title === 'Straight to main');
  assert.ok(row, `a push to main is not a direct landing: ${JSON.stringify(rows).slice(0, 300)}`);
  await withChrome({ ...chrome, name: 'landings-direct' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: chrome.origin, account }, repo, '/changes');
    await page.getByRole('button', { name: 'Landed', exact: true }).click();
    const list = page.getByRole('list', { name: 'landed Landings' });
    await see(list.getByRole('listitem').filter({ hasText: 'Straight to main' }).getByText('Landed directly'), '"Landed directly" on the row');
    await shot('landings-direct');
  });
  m.direct = rows.length;
}

/** 35: `chrome` and `account` drive Settings and the pages. */
export async function landingsFlow(kit, { chrome, account, credentials }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const repo = await kitRepo(kit, 'kit-landings');
  m.repo = repo.id;
  const dir = await cloneOf(kit, repo, 'landings');
  await switchOn(kit, repo, dir, { chrome, account }, m);
  const number = await perPush(kit, repo, dir, m);
  await adoption(kit, repo, dir, number, m);
  await afterwards(kit, repo, dir, number, m);
  await direct(kit, repo, { chrome, account }, m);
  await landingStates(kit, { chrome, account, credentials }, m);
}
