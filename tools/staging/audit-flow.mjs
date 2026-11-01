// Item 41 of the staging kit (no model): an organization's audit log of repository events, behind
// AUDIT_LOG. While that is off the item stops at once with a note: `GET /orgs/:org` says whether
// the log is kept. With it on, a throwaway org's repository is made public, renamed, given a
// member and a token, its rules and retention changed, a webhook added and removed, and deleted.
// Each reaches the log once, with who did it; the kind and actor filters, the chain's walk, both
// exports and the Audit log page read it back; a member who is no owner is refused, and another
// repository of the kit's, which no org owns, reaches no log.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';
import { b64, OWN_TRAFFIC } from './client.mjs';
import { author, refusal } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';

export const AUDIT_OFF = 'AUDIT_LOG is off on this platform. To run it: set AUDIT_LOG=on on the platform and front Workers in infra/envs/<env>.json (sign-ins go through both) and deploy';
const policy = { required_checks: [], approvals: 0 };
const HOOK = 'https://hooks.example.com/s3cr3t-path?key=abc';

const expected = [
  'repo.created',
  'repo.visibility_changed',
  'repo.renamed',
  'repo.member_put',
  'repo.member_removed',
  'repo.token_created',
  'repo.token_revoked',
  'repo.policy_changed',
  'repo.retention_changed',
  'webhook.created',
  'webhook.deleted',
  'repo.deleted',
];

async function everyAction(platform, repo, renamed, member) {
  const steps = [
    ['PUT', `/repos/${repo}/visibility`, { visibility: 'public' }],
    ['PUT', `/repos/${repo}/name`, { name: renamed }],
    ['POST', `/repos/${repo}/members`, { account: member, role: 'write' }],
    ['DELETE', `/repos/${repo}/members/${member}`],
    ['POST', `/repos/${repo}/tokens`, { name: 'kit-audit', scopes: ['read'] }],
    ['DELETE', `/repos/${repo}/tokens/kit-audit`],
    ['PUT', `/repos/${repo}/policy`, { policy: { required_checks: ['unit'], approvals: 2 } }],
    ['PUT', `/repos/${repo}/retention`, { keep_versions: 100, keep_days: 10 }],
  ];
  for (const [method, path, body] of steps) await platform.call(method, path, body);
  const hook = await platform.post(`/repos/${repo}/hooks`, { url: HOOK });
  await platform.call('DELETE', `/repos/${repo}/hooks/${hook.id}`);
}

/** The repository rows oldest first, once the log holds `count` of them. */
async function logged(platform, org, count) {
  for (const deadline = Date.now() + 30_000; ; await new Promise((r) => setTimeout(r, 500))) {
    const { items } = await platform.get(`/orgs/${org}/audit?limit=200`);
    const rows = items.filter((row) => row.source.startsWith('repo:')).reverse();
    if (rows.length >= count || Date.now() > deadline) return rows;
  }
}

async function readBack(platform, org, kitName, renamed, m) {
  const rows = await logged(platform, org, expected.length);
  assert.deepEqual(rows.map((r) => r.kind), expected, 'the repository events in the log');
  assert.ok(rows.every((r) => r.actor === `user:${kitName}`), `an event names someone else: ${JSON.stringify(rows.map((r) => r.actor))}`);
  const named = (await platform.get(`/orgs/${org}/audit?kind=repo.renamed`)).items;
  assert.deepEqual(named.map((r) => r.kind), ['repo.renamed'], 'the kind filter');
  assert.ok(JSON.stringify(named[0].details).includes(renamed), `the rename's details: ${JSON.stringify(named[0].details)}`);
  const mine = (await platform.get(`/orgs/${org}/audit?actor=${kitName}&limit=200`)).items;
  assert.ok(mine.length >= expected.length, 'the actor filter');
  const hook = rows.find((r) => r.kind === 'webhook.created');
  assert.equal(hook.details.host, 'hooks.example.com', 'the webhook\'s host');
  assert.ok(!JSON.stringify(rows).includes('s3cr3t-path'), 'the log keeps a webhook URL\'s path');
  const walk = await platform.get(`/orgs/${org}/audit/verify`);
  assert.equal(walk.ok, true, `the chain's walk: ${JSON.stringify(walk).slice(0, 200)}`);
  m.audit_events = rows.length;
}

/** An export is a file, so it is read as text. */
async function exported({ origin, cookie }, org, format) {
  const response = await fetch(`${origin}/api/v1/orgs/${org}/audit/export?format=${format}`, { headers: { cookie, ...OWN_TRAFFIC } });
  assert.ok(response.ok, `the ${format} export: ${response.status}`);
  return response.text();
}

async function downloads(web, org, m) {
  assert.ok((await exported(web, org, 'csv')).includes('repo.renamed'), 'the CSV export lacks the rename');
  assert.ok((await exported(web, org, 'json')).includes('repo.deleted'), 'the JSON export lacks the deletion');
  m.audit_exports = 'csv,json';
}

async function strangers(platform, org, other, kit, m) {
  await platform.post(`/orgs/${org}/members`, { account: other.name, role: 'member' });
  try {
    const refused = await other.session.raw('GET', `/orgs/${org}/audit`);
    assert.equal(refused.status, 403, `a member who is no owner read the log: ${refusal(refused)}`);
  } finally {
    await platform.call('DELETE', `/orgs/${org}/members/${other.name}`);
  }
  const name = `kit-audit-personal-${Date.now()}`;
  const before = (await platform.get(`/orgs/${org}/audit?limit=200`)).items.length;
  const { id } = await platform.post('/repos', { name, policy, files: [{ path: 'README.md', content_b64: b64('# personal\n') }], author });
  await platform.call('PUT', `/repos/${id}/visibility`, { visibility: 'public' });
  const gone = await platform.raw('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`);
  assert.ok(gone.ok, `deleting ${name}: ${refusal(gone)}`);
  assert.equal((await platform.get(`/orgs/${org}/audit?limit=200`)).items.length, before, 'a personal repository reached an org\'s log');
  m.audit_refused = 'member, personal repository';
  return kit;
}

async function logPage({ chrome }, org, m) {
  await withChrome({ ...chrome, name: 'audit' }, m, async ({ page, shot }) => {
    await page.goto(`${chrome.origin}/orgs/${org}/audit`);
    const log = page.getByRole('region', { name: 'Audit log' });
    await see(page.getByRole('heading', { name: 'Audit log' }), 'the Audit log heading');
    await see(page.getByRole('cell', { name: 'Repository renamed' }), 'the rename in the log');
    await page.getByLabel('Event').selectOption('repo.deleted');
    await see(page.getByRole('cell', { name: 'Repository deleted' }), 'the kind filter on the page');
    assert.equal(await page.getByRole('cell', { name: 'Repository renamed' }).count(), 0, 'the filter left the rename');
    await shot('audit-log');
    return log;
  });
}

/** 41: `platform` is the kit's session, `kitName` its account; `chrome` for the page. */
export async function auditFlow({ platform, kitName, chrome, cookie, origin, credentials }, m) {
  const org = `kit_audit_${Date.now().toString(36)}`;
  await platform.post('/orgs', { name: org });
  try {
    if (!(await platform.get(`/orgs/${org}`)).audit_log) return { skip: AUDIT_OFF };
    const other = await credentials.second();
    const name = `kit-audit-${Date.now()}`;
    const { id } = await platform.post('/repos', { name, owner: org, policy, files: [{ path: 'README.md', content_b64: b64('# audit\n') }], author });
    const renamed = `${name}-renamed`;
    await everyAction(platform, id, renamed, other.name);
    const gone = await platform.raw('DELETE', `/repos/${id}?confirm=${encodeURIComponent(renamed)}`);
    assert.ok(gone.ok, `deleting the repository: ${refusal(gone)}`);
    await readBack(platform, org, kitName, renamed, m);
    if (cookie) await downloads({ origin, cookie }, org, m);
    await strangers(platform, org, other, kitName, m);
    if (chrome) await logPage({ chrome }, org, m);
  } finally {
    await platform.raw('DELETE', `/orgs/${org}?confirm=${org}`);
  }
}
