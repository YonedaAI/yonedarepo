// Item 40 of the staging kit (no model): an organization deleted while one of its repositories is
// being created. Rounds at a spread of offsets race the two on live authorities; one must win:
// either the repository exists, the delete was refused and both can then be deleted, or the org
// is gone, the create was refused and nothing is listed. Never both: that left a repository nobody
// could delete. Then the browser's own path through an org (its repository create waits out the
// dialog's 45 s bound, and cleanup never runs under a create in flight).
import assert from 'node:assert/strict';
import { orgPages } from './browser-collab-flow.mjs';
import { b64, sleep } from './client.mjs';
import { author, refusal } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';

/** How long after the create the delete starts; below zero, how long before it. */
const OFFSETS_MS = [-150, -60, -20, 0, 25, 50, 100, 200, 400];

/** Deletes the race's repository, then its org: both must go, or something is stranded. */
async function clearUp(platform, org, { id, name }) {
  const repo = await platform.raw('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`);
  assert.ok(repo.ok, `the repository that won is left undeletable: ${refusal(repo)}`);
  const gone = await platform.raw('DELETE', `/orgs/${org}?confirm=${org}`);
  assert.ok(gone.ok, `the org is left undeletable: ${refusal(gone)}`);
}

/** One round: the delete starts `offset` ms after the create. Answers who won. */
async function round(platform, offset) {
  const org = `kit_race_${Date.now().toString(36)}`;
  const name = `kit-race-${Date.now()}`;
  await platform.post('/orgs', { name: org });
  const body = { name, owner: org, policy: { approvals: 0, required_checks: [] }, files: [{ path: 'README.md', content_b64: b64('# race\n') }], author };
  const later = async (ms, call) => {
    await sleep(ms);
    return call();
  };
  const [created, deleted] = await Promise.all([
    later(Math.max(-offset, 0), () => platform.raw('POST', '/repos', body)),
    later(Math.max(offset, 0), () => platform.raw('DELETE', `/orgs/${org}?confirm=${org}`)),
  ]);
  const said = `delete at ${offset} ms: create ${refusal(created)}, delete ${refusal(deleted)}`;
  assert.ok(!(created.ok && deleted.ok), `both won, ${said}: the repository has no owner`);
  if (created.ok) {
    assert.equal(deleted.status, 409, `the delete lost, ${said}`);
    assert.equal((await platform.get(`/orgs/${org}`)).org, org, `the org is gone, ${said}`);
    assert.ok((await platform.get(`/orgs/${org}/repos`)).repos.some((r) => r.id === created.body.id), `the repository is not listed, ${said}`);
    await clearUp(platform, org, { id: created.body.id, name });
    return 'create';
  }
  assert.ok(deleted.ok, `neither won, ${said}: the org keeps a hold for an hour`);
  // GONE past the owner's check; refused at that check if the org had gone before it.
  assert.ok([403, 404].includes(created.status), `the create lost, ${said}`);
  assert.ok(!(await platform.get('/repos')).repos.some((r) => r.name === name), `a repository is listed for a deleted org, ${said}`);
  return 'delete';
}

/** 40: `platform` is the kit's session; `chrome` and `account` run the org pages. */
export async function orgRace({ platform, chrome, account, credentials }, m) {
  const wins = { create: 0, delete: 0 };
  for (const offset of OFFSETS_MS) wins[await round(platform, offset)] += 1;
  Object.assign(m, { create_won: wins.create, delete_won: wins.delete });
  assert.ok(wins.create && wins.delete, `only one side ever won (${JSON.stringify(wins)}): the rounds did not race`);
  if (!chrome) return;
  const member = await credentials.second();
  await withChrome({ ...chrome, name: 'org-race' }, m, async ({ page, shot }) => {
    const cleanup = [];
    try {
      await page.goto(chrome.origin);
      await page.getByRole('button', { name: 'New repository' }).first().waitFor();
      await orgPages(page, { account, member, shot, cleanup }, m);
    } finally {
      for (const undo of cleanup.reverse()) await undo();
    }
  });
}
