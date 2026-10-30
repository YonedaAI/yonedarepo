// Browser gate, credentials and org administration (part of kit item `browser`), driven
// through the served app's own controls. Settings → Organizations creates a throwaway org;
// Personal access tokens creates a token limited to it, shown exactly once ("I saved it"
// removes it from the page), which then reads that org but no repository outside it, and is
// revoked from its row (the API refuses it afterwards). The repository's Settings →
// Repository tokens does the same for a path-limited repository token. Finally the org page's
// "Delete organization" (typed-name confirm) retires the org. A repository deleted by API
// while its page is open must turn into one "Repository not found" page and leave the sidebar.
// The API is used only to check the tokens, delete and read results back; cleanup revokes and
// deletes whatever a failure left.
import assert from 'node:assert/strict';
import { Session, sleep, until } from './client.mjs';
import { see, railOrg } from './browser-collab-flow.mjs';
import { accountSettings, newRepository, settle } from './browser-flow.mjs';

/** Accepts the next window.confirm (revoking asks first). */
const acceptConfirm = (page) => page.once('dialog', (dialog) => dialog.accept());

/** The one-time secret in `region`, then "I saved it": the page must no longer hold it. */
async function shownOnce(page, region, prefix, secrets, what) {
  const once = region.getByRole('status').filter({ hasText: 'It will not be shown again.' });
  await settle(once, [region.getByRole('alert')], { timeoutMs: 30_000, what });
  const token = (await once.locator('code').innerText()).trim();
  assert.ok(token.startsWith(prefix), `${what}: the shown secret does not start with ${prefix}`);
  secrets.push(token);
  await once.getByRole('button', { name: 'I saved it' }).click();
  await once.waitFor({ state: 'detached' });
  assert.ok(!(await page.content()).includes(token), `${what}: the secret is still in the page`);
  return token;
}

/** Waits until `session` is refused (401/403/404) for `path`: revocation took effect. */
async function refused(session, path, what) {
  await until(async () => [401, 403, 404].includes((await session.raw('GET', path)).status), {
    timeoutMs: 15_000,
    intervalMs: 500,
    what,
  });
}

export async function adminPages(page, { api, account, repo: { id, name }, shot, cleanup, secrets }, m) {
  // A throwaway org: created in Settings, deleted at the end through its page.
  const org = `kit_del_${Date.now().toString(36)}`;
  let orgDeleted = false;
  cleanup.push(async () => {
    if (!orgDeleted) await account.raw('DELETE', `/api/v1/orgs/${org}?confirm=${org}`);
  });
  await accountSettings(page, 'Organizations');
  const orgs = page.getByRole('region', { name: 'Organizations', exact: true });
  await orgs.getByLabel('New organization').fill(org);
  await orgs.getByRole('button', { name: 'Create organization' }).click();
  await settle(page.getByRole('heading', { level: 1, name: org }), [orgs.getByRole('alert')], { timeoutMs: 30_000, what: 'creating the organization to delete' });

  // Personal access token, limited to the org: shown once, used, revoked from its row.
  await accountSettings(page, 'Tokens');
  const pats = page.getByRole('region', { name: 'Personal access tokens', exact: true });
  const patForm = pats.getByRole('form', { name: 'Create a personal access token' });
  const patName = `kit-pat-${Date.now().toString(36)}`;
  await patForm.getByLabel('Name', { exact: true }).fill(patName);
  await patForm.getByLabel(/^Organization/).selectOption({ label: `Only ${org}` }).catch((e) => {
    throw new Error(`the Organization limit does not offer ${org}: ${e.message.split('\n')[0]}`);
  });
  await patForm.getByRole('button', { name: 'Create token' }).click();
  const pat = await shownOnce(page, pats, 'ypat_', secrets, 'creating the personal token');
  cleanup.push(async () => {
    const listed = (await account.get('/api/v1/tokens')).tokens.find((t) => t.name === patName);
    if (listed) await account.raw('DELETE', `/api/v1/tokens/${listed.id}`);
  });
  const row = pats.getByRole('row').filter({ has: page.getByRole('cell', { name: patName, exact: true }) });
  await see(row.getByRole('cell', { name: org, exact: true }), `the token row naming its org ${org}`);
  await shot('pat-created');
  const bearer = new Session(api, { bearer: pat });
  assert.equal((await bearer.get(`/api/v1/orgs/${org}`)).org, org, 'the org-limited token cannot read its org');
  const reach = (await bearer.get('/api/v1/repos')).repos;
  assert.ok(!reach.some((r) => r.id === id), 'the org-limited token reaches a repository outside its org');
  acceptConfirm(page);
  await pats.getByRole('button', { name: `Revoke ${patName}`, exact: true }).click();
  await row.waitFor({ state: 'detached' });
  await refused(bearer, `/api/v1/orgs/${org}`, 'the revoked personal token to be refused');
  assert.ok(!(await account.get('/api/v1/tokens')).tokens.some((t) => t.name === patName), 'the revoked token is still listed');
  await shot('pat-revoked');
  m.pat_org_limited = org;

  // Repository token, limited to docs/: shown once, used, revoked from its row.
  await page.getByRole('navigation', { name: 'Repositories' }).getByRole('link', { name, exact: true }).click();
  await page.waitForURL(`**/source/${id}`);
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Repository tokens' }).click();
  const repoTokens = page.getByRole('region', { name: 'Repository tokens', exact: true });
  const tokenForm = repoTokens.getByRole('form', { name: 'Create a repository token' });
  const tokenName = `kit-${Date.now().toString(36)}`;
  await tokenForm.getByLabel('Name', { exact: true }).fill(tokenName);
  await tokenForm.getByLabel(/^Paths/).fill('docs/');
  await tokenForm.getByRole('button', { name: 'Create repository token' }).click();
  const repoToken = await shownOnce(page, repoTokens, 'yrp_', secrets, 'creating the repository token');
  cleanup.push(() => account.raw('DELETE', `/api/v1/repos/${id}/tokens/${tokenName}`));
  const tokenRow = repoTokens.getByRole('row').filter({ has: page.getByRole('cell', { name: tokenName, exact: true }) });
  await see(tokenRow.getByRole('cell', { name: 'docs/', exact: true }), 'the repository token row with its path grant');
  await shot('repo-token-created');
  const scoped = new Session(api, { bearer: repoToken });
  const status = await scoped.raw('GET', `/api/v1/repos/${id}`);
  assert.equal(status.status, 200, 'the repository token cannot read its repository');
  assert.deepEqual(status.body.grant, ['docs/'], 'the repository token does not carry its path grant');
  acceptConfirm(page);
  await repoTokens.getByRole('button', { name: `Revoke ${tokenName}`, exact: true }).click();
  await tokenRow.waitFor({ state: 'detached' });
  await refused(scoped, `/api/v1/repos/${id}`, 'the revoked repository token to be refused');
  await shot('repo-token-revoked');
  m.repo_token_paths = 'docs/';

  // Delete the org from its page: typed-name confirm, then the shell leaves for Settings.
  await railOrg(page, org).click();
  await page.waitForURL(`**/orgs/${org}`);
  const danger = page.getByRole('region', { name: 'Delete organization', exact: true });
  const confirm = danger.getByRole('button', { name: 'Delete this organization' });
  assert.ok(await confirm.isDisabled(), 'Delete this organization is enabled before the name is typed');
  await danger.getByLabel('Organization name').fill(org);
  await shot('org-delete');
  await confirm.click();
  await settle(page.getByRole('status').filter({ hasText: 'Organization deleted.' }), [danger.getByRole('alert')], { timeoutMs: 30_000, what: 'deleting the organization' });
  await page.waitForURL('**/settings/organizations');
  orgDeleted = true;
  assert.notEqual((await account.raw('GET', `/api/v1/orgs/${org}`)).status, 200, 'the deleted org is still served');
  // Org access is cached up to 1 s per isolate: past that, a reload must not list it.
  await until(async () => !(await account.get('/api/v1/orgs')).orgs.some((o) => o.org === org), {
    timeoutMs: 10_000,
    intervalMs: 500,
    what: `${org} gone from the caller's orgs`,
  });
  await sleep(1_000);
  await page.reload();
  await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
  assert.equal(await railOrg(page, org).count(), 0, `${org} is still in the sidebar`);
  await shot('org-deleted');
  m.org_deleted_in_ui = org;
}

/**
 * A repository deleted while its page is open: created in the shell, opened on History,
 * then deleted by API. The next read (the Changes tab) answers GONE, and the page must show
 * one "Repository not found" page (no error boxes) and drop it from the sidebar. A stale link
 * to one of its sub-routes shows the same page.
 */
export async function deletedRepoPage(page, { origin, account, shot, cleanup }, m) {
  const name = `kit-gone-${Date.now()}`;
  await page.goto(origin);
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/repos' && r.request().method() === 'POST');
  await newRepository(page, name);
  const response = await created;
  assert.ok(response.ok(), `Create repository: HTTP ${response.status()}`);
  const { id } = await response.json();
  const remove = () => account.raw('DELETE', `/api/v1/repos/${id}?confirm=${encodeURIComponent(name)}`);
  let deleted = false;
  cleanup.push(async () => {
    if (!deleted) await remove();
  });
  const rail = page.getByRole('navigation', { name: 'Repositories' }).getByRole('link', { name, exact: true });
  await rail.waitFor();
  await page.waitForURL(`**/source/${id}`);
  const tabs = page.getByRole('navigation', { name: 'Repository' });
  await tabs.getByRole('link', { name: 'Commits' }).click();
  await page.getByRole('list', { name: 'History of main' }).getByRole('listitem').first().waitFor();
  const done = await remove();
  assert.ok(done.ok, `Delete repository: ${done.status} ${done.body?.error?.code ?? ''}`);
  deleted = true;
  const notFound = page.getByRole('region', { name: 'Repository not found' });
  const expectNotFound = async (what) => {
    await notFound.getByRole('heading', { level: 1, name: 'Repository not found' }).waitFor();
    await notFound.getByText("This repository doesn't exist or was deleted, or you don't have access.").waitFor();
    await notFound.getByRole('link', { name: 'Repositories', exact: true }).waitFor();
    await notFound.getByRole('button', { name: 'New repository' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, `${what}: error boxes beside the not-found page`);
    assert.equal(await tabs.count(), 0, `${what}: the repository tabs are still shown`);
  };
  await tabs.getByRole('link', { name: 'Changes' }).click();
  await expectNotFound('deleted while open');
  await rail.waitFor({ state: 'detached' });
  await shot('repo-deleted-while-open');
  await page.goto(`${origin}/source/${id}/agents`);
  await expectNotFound('a stale link');
  assert.equal(await rail.count(), 0, `${name} is back in the sidebar`);
  await shot('repo-stale-link');
  m.repo_not_found = 'deleted-while-open,stale-sub-route';
}
