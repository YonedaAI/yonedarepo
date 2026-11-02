// Kit item 48 (no model): every command, subcommand and flag of `yoneda`, for real, on the owner's
// dev account, in throwaway HOMEs, on repositories and organizations named cli-walk-<ms>. Nothing
// outside those is written, and all of it is deleted at the end, with every token revoked. A row
// passes on what the command did, read back; the table below is checked against args/*.rs, so a
// new flag fails the item until a row names it. `--cli-walk`; CLI_WALK_SECTIONS=reads,land runs
// the sign-in and those sections only (for repeating a fix), and the rows left out fail the item.
import assert from 'node:assert/strict';
import { accountRows } from './cli-walk-account.mjs';
import { changeRowsAll } from './cli-walk-change.mjs';
import { cloneRowsAll, seedTree } from './cli-walk-clone.mjs';
import { failureRowsAll } from './cli-walk-fail.mjs';
import { ALL_SCOPES, Walk } from './cli-walk-kit.mjs';
import { landRowsAll } from './cli-walk-land.mjs';
import { newUserRows } from './cli-walk-newuser.mjs';
import { readRows } from './cli-walk-reads.mjs';
import { sessionRowsAll } from './cli-walk-session.mjs';
import { coverageGaps, printable, TABLE } from './cli-walk-table.mjs';
import { toolRowsAll } from './cli-walk-tools.mjs';
import { readEnvFile, Session } from './client.mjs';
import { ownerLogin } from './realuser-flow.mjs';

/** Deletes what the walk made; what fails is named, and the item fails. */
async function cleanUp(w, m) {
  const left = [];
  const attempt = async (what, body) => body().catch((e) => left.push(`${what}: ${e.message}`));
  for (const { id, name } of w.repos.filter((r) => r.id)) await attempt(`repository ${name}`, () => w.owner.call('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`));
  for (const org of w.orgs) await attempt(`organization ${org}`, () => w.owner.call('DELETE', `/orgs/${org}?confirm=${encodeURIComponent(org)}`));
  const { keys = [] } = await w.owner.get('/ssh-keys').catch(() => ({}));
  for (const key of keys.filter((k) => w.keys.includes(k.id) || w.keys.includes(k.fingerprint))) await attempt(`SSH key ${key.id}`, () => w.owner.call('DELETE', `/ssh-keys/${key.id}`));
  for (const { session, id } of w.tokens) await attempt(`token ${id}`, () => session.call('DELETE', `/tokens/${id}`));
  m.left_behind = left;
}

/** The sections a run takes: all of them, unless CLI_WALK_SECTIONS names some. */
const sections = (names) => (name) => !names || names.split(',').includes(name);

async function walkThrough(w, { chrome, kitName, kitSession }, m) {
  const on = sections(process.env.CLI_WALK_SECTIONS);
  const { me, repos } = await accountRows(w);
  assert.ok(me.token, `sign-in failed, so nothing else can run: ${w.results.get('login (opens the browser)')?.note}`);
  w.ownerCli = me;
  assert.ok(repos.plain, 'repo create failed, so nothing else can run');
  w.ownerHandle = (await me.api.get(`/repos/${repos.plain.id}`)).owner_handle;
  const reviewer = w.person('reviewer');
  await reviewer.login({ approver: kitSession, scopes: ALL_SCOPES });
  const tree = on('clone') ? await cloneRowsAll(w, me, repos) : await seedTree(w, me);
  if (on('newuser')) await newUserRows(w, { chrome, m });
  if (on('reads')) await readRows(w, me, tree);
  if (on('land')) await landRowsAll(w, me);
  if (on('change')) await changeRowsAll(w, me, reviewer, kitName);
  if (on('session')) await sessionRowsAll(w, me);
  if (on('tools')) await toolRowsAll(w, me, tree, kitName);
  if (on('fail')) await failureRowsAll(w, me, reviewer, tree);
  if (on('json')) await w.row('--json: every schema in schemas/v1 was printed', async () => {
    const missing = w.allSchemas().filter((name) => !w.schemas.has(name));
    assert.deepEqual(missing, [], `never printed: ${missing.join(', ')}`);
  });
}

export async function cliWalk({ origin, api, bin, root, headed, prod, kitName, kitSession }, m) {
  if (prod) return { skip: 'Dev only: it writes on the dev owner\'s account' };
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = readEnvFile('dev-owner.env', { required: false });
  if (!username || !password) return { skip: 'No DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD in dev-owner.env' };
  const cookie = await ownerLogin(origin, username, password);
  const owner = new Session(`${origin}/api/v1`, { cookie });
  const w = new Walk({ api, origin, bin, owner, root, table: TABLE });
  w.secrets.add(password).add(cookie.split('=').slice(1).join('='));
  try {
    const gaps = coverageGaps(root);
    await walkThrough(w, { chrome: { origin, root, headed, cookie }, kitName, kitSession }, m);
    const unrun = TABLE.filter((id) => !w.results.has(id));
    for (const id of unrun) w.results.set(id, { status: 'fail', ms: 0, note: 'no result: this row never ran' });
    const rows = TABLE.map((id) => ({ row: id, ...w.results.get(id) }));
    const count = (status) => rows.filter((r) => r.status === status).length;
    Object.assign(m, { rows, commands: rows.length, passed: count('pass'), failed: count('fail'), not_run: count('not run'), json_schemas: w.schemas.size, table_gaps: gaps });
    console.log(printable(rows));
    assert.deepEqual(gaps, [], `in args/*.rs, in no row of the table: ${gaps.join(', ')}`);
    assert.equal(m.failed, 0, `${m.failed} of ${rows.length} rows failed: ${rows.filter((r) => r.status === 'fail').map((r) => r.row).join('; ')}`);
  } finally {
    await cleanUp(w, m);
    await new Session(origin, { cookie }).raw('POST', '/api/auth/logout').catch(() => {});
    w.dispose();
  }
  assert.deepEqual(m.left_behind, [], 'cleanup left something behind');
}
