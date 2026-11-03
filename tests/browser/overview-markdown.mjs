import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { OWN_TRAFFIC } from '../../tools/own-traffic.mjs';
// APIs are synthetic; this checks a served frontend build without accounts or paid services.
const base = process.env.PRELOAD_TEST_URL;
assert.ok(base, 'Set PRELOAD_TEST_URL to the served production build');
const expected = process.env.PRELOAD_EXPECT !== 'off';
const events = [];
const repo = 'r0123456789abcdef0123',
  commit = 'a'.repeat(40),
  source = '# A formatted README\n\n**Useful content.**';
const summary = {
  name: 'repo',
  version: 1,
  owner: 'demo',
  owner_handle: 'demo',
  path: '/demo/repo',
  object_store: 'r2:demo',
  policy: { approvals: 0, required_checks: [] },
  policy_digest: 'd',
  refs: [{ name: 'refs/heads/main', commit_id: commit, version: 1 }],
  bundled: false,
  automation: null,
  landings: { create: false, agents: false },
  parent: null,
  forks: 0,
  visibility: 'private',
  viewer: { owner: true, principal: 'user:demo', role: null, public: false },
  grant: null,
  quarantined: [],
  quarantine_epoch: 0,
  overview: {
    ref: 'main',
    empty: false,
    tree: { commit, path: '', entries: [{ name: 'README.md', type: 'blob', id: 'b'.repeat(40) }] },
    latest: {
      commit,
      message: 'A useful update',
      principal: 'user:demo',
      author_name: 'Demo',
      authored_at: Date.now(),
      landings: [],
      checks: [],
    },
    activity: {
      commits: [{ commit, principal: 'user:demo', author_name: 'Demo', authored_at: Date.now() }],
    },
    readme: {
      commit,
      path: 'README.md',
      encoding: 'utf-8',
      content: source,
      size: source.length,
      executable: false,
    },
  },
};
let release, arrive;
const held = new Promise((r) => (release = r)),
  requested = new Promise((r) => (arrive = r));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ extraHTTPHeaders: OWN_TRAFFIC });
page.on('request', (r) => {
  if (r.url().includes('/assets/GfmDocument-')) events.push({ kind: 'parser', at: Date.now() });
});
await page.route('**/api/**', async (route) => {
  const u = new URL(route.request().url());
  let data = {};
  if (u.pathname === '/api/auth/session')
    data = { authenticated: true, username: 'demo', handle: 'demo' };
  else if (u.pathname === '/api/v1/repos') data = { repos: [] };
  else if (u.pathname === '/api/v1/orgs') data = { orgs: [] };
  else if (u.pathname === '/api/v1/favorites') data = { favorites: [] };
  else if (u.pathname.startsWith('/api/v1/resolve/')) {
    events.push({ kind: 'api-held', at: Date.now() });
    arrive();
    await held;
    events.push({ kind: 'api-released', at: Date.now() });
    data = { id: repo, handle: 'demo', name: 'repo', path: '/demo/repo', summary };
  } else if (u.pathname === `/api/v1/repos/${repo}`) data = summary;
  else if (u.pathname.endsWith('/hold')) data = { held: false };
  try {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  } catch {}
});
let before;
try {
  await page.goto(`${base}/demo/repo`, { waitUntil: 'domcontentloaded' });
  await requested;
  await page.waitForTimeout(1000);
  before = events.some((e) => e.kind === 'parser');
  release();
  await page.locator('.readme-body a.md-anchor').waitFor();
  assert.equal(before, expected, 'full parser must start alongside API, not after README arrives');
} finally {
  release();
  await browser.close();
}
console.log(JSON.stringify({ expected, before, events }));
