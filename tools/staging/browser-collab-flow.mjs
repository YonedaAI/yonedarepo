// Browser gate, collaboration pages (part of kit item `browser`): releases, forks and
// organizations, each driven through the served app's own controls. The API (with the
// browser's session cookie, or the second kit account) only sets up what one person cannot
// do in one browser (an annotated tag, a branch commit), reads results back and cleans up.
//
// Releases: the Releases tab's empty state, then "New release" for an annotated tag with
// notes, an asset attached through the file input and downloaded through its link (bytes and
// sha256 match the upload), and the release deleted. Forks: "Fork" under a new name shows
// "forked from <parent>"; a branch on the fork opens a change on the parent through
// "Open change" → "Parent <id>". Orgs: Settings → Organizations creates one, its page creates
// team "devs" and adds the second kit account to the org and the team; "New repository" with
// the org as owner, then repository Members grants team:<org>/devs; the org page lists it.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { b64, sleep, until } from './client.mjs';
import { accountSettings, settle } from './browser-flow.mjs';

const author = { name: 'Browser gate', email: 'kit@yonedarepo.invalid' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Waits for `locator`, failing with `what` rather than Playwright's selector dump. */
export async function see(locator, what, timeout = 30_000) {
  await locator.first().waitFor({ timeout }).catch((error) => {
    throw new Error(`${what} is not shown (${error.message.split('\n')[0]})`);
  });
}

/** The org's sidebar link. Its accessible name runs the role label on ("<org>owner"), so it
 * is matched by the link's name text, exactly. */
export const railOrg = (page, org) =>
  page
    .getByRole('navigation', { name: 'Organizations', exact: true })
    .getByRole('link')
    .filter({ has: page.locator('.rail-repo-name').getByText(org, { exact: true }) });

/** Releases tab: empty state, publish for an annotated tag, attach and download an asset, delete. */
export async function releasePages(page, { account, repo: { id, name }, shot }, m) {
  const api = (path) => `/api/v1/repos/${id}${path}`;
  const tabs = page.getByRole('navigation', { name: 'Repository' });
  await page.getByRole('navigation', { name: 'Repositories' }).getByRole('link', { name, exact: true }).click();
  await page.waitForURL(`**/source/${id}`);
  await tabs.getByRole('link', { name: 'Releases' }).click();
  await page.waitForURL(`**/source/${id}/releases`);
  await see(page.getByText(/^No releases yet\. Push a tag/), 'the Releases empty state with its next action');
  await shot('releases-empty');

  // The tag is setup (git push or POST /tags); the tab's tag picker loads refs on open.
  const main = (await account.get(api('/refs'))).refs['refs/heads/main'];
  const tag = 'v1';
  await account.post(api('/tags'), { name: tag, commit: main, message: 'Browser gate tag' });
  // Another isolate may answer from a head copy up to ACCESS_MS (1 s) old: wait until the
  // tag reads back, then out the bound, so the tab's refs read is not a stale copy.
  await until(async () => (await account.get(api('/refs'))).refs[`refs/tags/${tag}`] === main, {
    timeoutMs: 10_000,
    intervalMs: 250,
    what: `tag ${tag} in the repository's refs`,
  });
  await sleep(1_000);
  await tabs.getByRole('link', { name: 'Overview' }).click();
  await tabs.getByRole('link', { name: 'Releases' }).click();
  await page.getByRole('button', { name: 'New release' }).click();
  const form = page.getByRole('form', { name: 'Publish a release' });
  await see(form, 'the Publish a release form');
  await form.getByLabel('Tag').selectOption(tag).catch((e) => {
    throw new Error(`the Tag picker does not offer ${tag}: ${e.message.split('\n')[0]}`);
  });
  const title = 'Browser gate release';
  const notes = 'Release notes from the browser gate.';
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Notes').fill(notes);
  await form.getByRole('button', { name: 'Publish release' }).click();
  const view = page.locator('section.source-release');
  await settle(view.getByRole('heading', { name: title }), [form.getByRole('alert')], { timeoutMs: 30_000, what: 'publishing the release' });
  await page.waitForURL(`**/source/${id}/releases/${tag}`);
  await see(view.getByText(notes), 'the release notes');
  await see(view.getByRole('region', { name: 'Tag message', exact: true }).getByText('Browser gate tag'), 'the annotated tag message');
  await see(view.getByText('No assets.'), 'the release assets empty state');
  await shot('release-created');

  const bytes = randomBytes(4096);
  const asset = 'kit-asset.bin';
  const upload = page.getByRole('form', { name: 'Attach an asset' });
  await upload.getByLabel(/^Asset/).setInputFiles({ name: asset, mimeType: 'application/octet-stream', buffer: bytes });
  await upload.getByRole('button', { name: 'Upload asset' }).click();
  const assets = view.getByRole('list', { name: 'Assets' });
  await settle(assets.getByRole('link', { name: asset }), [upload.getByRole('alert')], { timeoutMs: 60_000, what: 'uploading the asset' });
  const shown = await assets.getByRole('listitem').filter({ hasText: asset }).locator('code').innerText();
  assert.equal(shown, sha256(bytes), 'the page shows another sha256 than the uploaded bytes');
  await shot('release-asset');
  // The asset link downloads with the session cookie.
  const [download] = await Promise.all([page.waitForEvent('download'), assets.getByRole('link', { name: asset }).click()]);
  const got = await readFile(await download.path());
  assert.equal(got.length, bytes.length, `the downloaded asset has ${got.length} bytes, not ${bytes.length}`);
  assert.equal(sha256(got), sha256(bytes), 'the downloaded asset differs from the upload');
  Object.assign(m, { release: tag, asset_bytes: got.length, asset_sha256: sha256(got).slice(0, 16) });

  await view.getByRole('button', { name: 'Delete release…' }).click();
  await view.getByRole('button', { name: 'Delete release', exact: true }).click();
  await page.waitForURL(`**/source/${id}/releases`);
  await see(page.getByText(/^No releases yet\./), 'the Releases empty state after deleting the release');
  await shot('release-deleted');
  assert.equal((await account.raw('GET', api(`/releases/${tag}`))).status, 404, 'the deleted release is still served');
  assert.equal((await account.get(api('/refs'))).refs[`refs/tags/${tag}`], main, 'deleting the release moved its tag');
}

/** "Fork" under a new name; then "Open change" on a fork branch, targeting the parent. */
export async function forkPages(page, { account, repo: { id, name }, shot, cleanup }, m) {
  await page.getByRole('navigation', { name: 'Repositories' }).getByRole('link', { name, exact: true }).click();
  await page.waitForURL(`**/source/${id}`);
  await page.locator('.repo-head').getByRole('button', { name: 'Fork', exact: true }).click();
  const form = page.getByRole('form', { name: 'Fork this repository' });
  const forkName = `${name}-fork`;
  await form.getByLabel('Fork name').fill(forkName);
  const forked = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/repos/${id}/fork` && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Fork', exact: true }).click();
  const response = await forked;
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok(), `Fork: HTTP ${response.status()} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`);
  const fork = body.id;
  m.fork = fork;
  // A parent refuses deletion while a fork is left: the fork goes first (cleanup runs in reverse).
  cleanup.push(async () => {
    const done = await account.raw('DELETE', `/api/v1/repos/${fork}?confirm=${encodeURIComponent(forkName)}`);
    assert.ok(done.ok, `Delete fork: ${done.status} ${done.body?.error?.code ?? ''}`);
  });
  await page.waitForURL(`**/source/${fork}`);
  const head = page.locator('.repo-head');
  await see(head.getByText(`forked from ${id}`), `"forked from ${id}" on the fork`);
  await see(head.getByRole('link', { name: id, exact: true }), 'the link to the parent');
  await shot('fork-created');

  // A branch on the fork (setup); the page reloads to list it.
  const forkApi = (path) => `/api/v1/repos/${fork}${path}`;
  const made = await account.post(forkApi('/commits'), {
    ref: 'main',
    changes: [{ path: 'docs/from-fork.md', content_b64: b64('From the browser gate fork.\n') }],
    message: 'Browser gate: work on a fork',
    author,
  });
  await account.post(forkApi('/branches'), { ref: 'kit-fork', commit: made.commit, expected: null });
  await page.reload();
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: 'Commits' }).click();
  const history = page.getByRole('region', { name: 'History', exact: true });
  await history.getByLabel('Branch').selectOption('kit-fork').catch((e) => {
    throw new Error(`the History Branch picker does not offer kit-fork: ${e.message.split('\n')[0]}`);
  });
  await page.waitForURL((url) => url.pathname === `/source/${fork}/history` && url.searchParams.get('ref') === 'kit-fork');
  await history.getByRole('button', { name: 'Open change' }).click();
  const open = page.getByRole('form', { name: 'Open a change for kit-fork' });
  await open.getByRole('button', { name: `Parent ${id}` }).click();
  await see(open.getByText(`of the parent ${id}`), 'the Open change form naming the parent as target');
  await open.getByLabel('Title').fill('Browser gate fork change');
  await shot('fork-open-change');
  await open.getByRole('button', { name: 'Open change' }).click();
  await settle(page.getByRole('heading', { name: /Browser gate fork change/ }), [open.getByRole('alert')], { timeoutMs: 60_000, what: 'opening the change on the parent' });
  assert.match(page.url(), new RegExp(`/source/${id}/changes/\\d+$`), `the change did not open on the parent: ${page.url()}`);
  await see(page.getByText(`${fork}:kit-fork`), 'the change naming its fork branch');
  await shot('fork-change');
  const number = Number(page.url().split('/').at(-1));
  const change = await account.get(`/api/v1/repos/${id}/changes/${number}`);
  assert.deepEqual([change.source_repo, change.branch, change.head], [fork, `forks/${fork}/kit-fork`, made.commit], 'the parent change does not propose the fork head');
  Object.assign(m, { fork_change: number });
}

/** Settings → Organizations, its page (team, members), an org-owned repository and its team grant. */
export async function orgPages(page, { account, member, shot, cleanup }, m) {
  const org = `kit_org_${Date.now().toString(36)}`;
  m.org = org;
  // The org goes last (an org that owns a repository is refused); its member first.
  cleanup.push(async () => {
    await account.raw('DELETE', `/api/v1/orgs/${org}/members/${member.name}`);
    const done = await account.raw('DELETE', `/api/v1/orgs/${org}?confirm=${org}`);
    assert.ok(done.ok, `Delete org: ${done.status} ${done.body?.error?.code ?? ''}`);
  });
  await accountSettings(page, 'Organizations');
  const orgs = page.getByRole('region', { name: 'Organizations', exact: true });
  await orgs.getByLabel('New organization').fill(org);
  await orgs.getByRole('button', { name: 'Create organization' }).click();
  await settle(page.getByRole('heading', { level: 1, name: org }), [orgs.getByRole('alert')], { timeoutMs: 30_000, what: 'creating the organization' });
  await page.waitForURL(`**/orgs/${org}`);
  await see(page.getByText(/You are an owner/), 'the org page naming the creator an owner');
  await see(railOrg(page, org), 'the org in the sidebar');

  const teams = page.getByRole('region', { name: 'Teams', exact: true });
  await see(teams.getByText('No teams yet.'), 'the Teams empty state');
  await teams.getByLabel('New team').fill('devs');
  await teams.getByRole('button', { name: 'Create team' }).click();
  const devs = teams.locator('li.org-team', { has: page.getByRole('heading', { name: /^devs/ }) });
  await settle(devs, [teams.getByRole('alert')], { timeoutMs: 30_000, what: 'creating team devs' });
  await see(devs.getByText(`team:${org}/devs`), `the team entry team:${org}/devs`);

  const members = page.getByRole('region', { name: 'Members', exact: true });
  await members.getByLabel(/^Account/).fill(member.name);
  await members.getByRole('button', { name: 'Add member' }).click();
  await settle(members.getByRole('cell', { name: member.name, exact: true }), [members.getByRole('alert')], { timeoutMs: 30_000, what: `adding ${member.name} to the org` });
  await devs.getByLabel('Add member').selectOption(member.name);
  await devs.getByRole('button', { name: 'Add', exact: true }).click();
  await settle(devs.getByRole('listitem').filter({ hasText: member.name }), [teams.getByRole('alert')], { timeoutMs: 30_000, what: `adding ${member.name} to team devs` });
  await shot('org-page');

  // New repository, owned by the org through the owner picker.
  const name = `kit-org-repo-${Date.now()}`;
  await page.getByRole('button', { name: 'New repository' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New repository' });
  await dialog.getByLabel('Owner').selectOption({ label: `${org} (organization)` }).catch((e) => {
    throw new Error(`the Owner picker does not offer ${org}: ${e.message.split('\n')[0]}`);
  });
  await dialog.getByLabel('Repository name').fill(name);
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/repos' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create repository' }).click();
  const response = await created;
  assert.ok(response.ok(), `Create org repository: HTTP ${response.status()}`);
  const { id } = await response.json();
  m.org_repo = id;
  cleanup.push(async () => {
    const done = await account.raw('DELETE', `/api/v1/repos/${id}?confirm=${encodeURIComponent(name)}`);
    assert.ok(done.ok, `Delete org repository: ${done.status} ${done.body?.error?.code ?? ''}`);
  });
  await page.waitForURL(`**/source/${id}`);

  // Repository Members: grant the team.
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Members' }).click();
  const grant = page.getByRole('region', { name: 'Members', exact: true });
  await see(grant.getByText('Only the owner uses this repository.'), 'the repository Members empty state');
  await grant.getByLabel(/^Grant to/).selectOption('team');
  await grant.getByLabel(/^Team/).fill(`${org}/devs`);
  await grant.getByLabel(/^Role(?! of)/).selectOption('write');
  await grant.getByRole('button', { name: 'Add team' }).click();
  await settle(grant.getByRole('cell', { name: `team ${org}/devs` }), [grant.getByRole('alert')], { timeoutMs: 30_000, what: `granting team:${org}/devs` });
  await shot('org-repo-members');

  await railOrg(page, org).click();
  await page.waitForURL(`**/orgs/${org}`);
  await see(page.getByRole('region', { name: 'Repositories', exact: true }).getByRole('link', { name }), `${name} on the org page`);
  await shot('org-repos');

  const listed = (await account.get(`/api/v1/orgs/${org}/repos`)).repos.find((r) => r.id === id);
  assert.equal(listed?.owner, org, `the repository is not owned by ${org}`);
  const granted = (await account.get(`/api/v1/repos/${id}/members`)).members.find((x) => x.account === `team:${org}/devs`);
  assert.equal(granted?.role, 'write', `team:${org}/devs does not hold write`);
  const shown = await account.get(`/api/v1/orgs/${org}`);
  assert.deepEqual(shown.teams.find((t) => t.name === 'devs')?.members, [member.name], 'team devs does not hold the second account');
}
