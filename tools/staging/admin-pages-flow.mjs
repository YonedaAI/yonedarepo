// Item 39 of the staging kit (no model, no money moves): the operators' pages, as the dev owner,
// whose credentials stay in dev-owner.env. Revenue reads by API and on Overview: the sum holds, a
// bad range says why, by month answers, and an account that is no operator is refused.
// `cargo xtask admin revenue-rebuild` refuses without --confirm, asks every account's ledger to
// push again and changes no total. Traffic reads by API and on its page, and our own traffic stays
// out: page views carrying the mark, at a path nobody else has, must never show. There is no
// unmarked control beside them, since a tool may not send one, so a platform that stopped
// counting altogether would pass that part: the item records the counts either side.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { see } from './browser-collab-flow.mjs';
import { readEnvFile, Session, sleep } from './client.mjs';
import { refusal, settled } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';
import { ownerLogin } from './realuser-flow.mjs';

const run = promisify(execFile);
const MARKED_VIEWS = 30;
/** Analytics Engine takes a point in under a minute; the next two reads are past that. */
const SETTLE_MS = 75_000;
const CLASSES = ['humans', 'agents', 'bots'];
const WORDS = /rollup|projection|outbox|durable object/i;
const day = (at) => new Date(at).toISOString().slice(0, 10);
const range = () => {
  const to = Date.now();
  return `from=${day(to - 29 * 86_400_000)}&to=${day(to)}`;
};
const cents = (usd) => Math.round(usd * 100);

async function revenueApi(owner, kitSession, m) {
  const path = `/admin/revenue?${range()}&by=day`;
  const report = await owner.get(path);
  const { gross_top_ups_usd: gross, refunds_usd: refunds, disputes_lost_usd: lost, net_revenue_usd: net } = report.totals;
  assert.equal(cents(net), cents(gross) - cents(refunds) - cents(lost), `the takings do not add up: ${JSON.stringify(report.totals)}`);
  assert.equal(report.source, 'ledger', 'revenue comes from somewhere else');
  assert.equal(report.stripe_fees_usd, null, 'Stripe fees are not recorded, so they read null');
  const byMonth = await owner.get(`/admin/revenue?${range()}&by=month`);
  assert.equal(cents(byMonth.totals.net_revenue_usd), cents(net), 'by month and by day disagree on one range');
  const refused = await kitSession.raw('GET', path);
  assert.ok([403, 404].includes(refused.status), `an account that is no operator read revenue: ${refusal(refused)}`);
  Object.assign(m, { revenue_net_usd: net, revenue_accounts: report.outstanding.accounts, revenue_refused: refusal(refused) });
  return { path, totals: JSON.stringify(report.totals) };
}

/** The repair command: refused unconfirmed; run, it moves no total. */
async function rebuild(root, owner, { path, totals }, m) {
  const { CARGO_TARGET_DIR: _, ...env } = process.env;
  const xtask = (...args) => run('cargo', ['xtask', 'admin', 'revenue-rebuild', '--env', 'dev', ...args], { cwd: root, env, timeout: 300_000, maxBuffer: 8 << 20 });
  const unconfirmed = await xtask().then(() => null, (e) => e);
  assert.match(unconfirmed?.stderr ?? '', /Pass --confirm/, 'revenue-rebuild ran without --confirm');
  const { stdout } = await xtask('--confirm');
  const asked = stdout.match(/dev: asked (\d+) accounts to push again/);
  assert.ok(asked, `revenue-rebuild said: ${stdout.slice(-300)}`);
  assert.ok(Number(asked[1]) > 0, 'revenue-rebuild asked no account');
  m.rebuild_asked = Number(asked[1]);
  await sleep(5_000);
  await settled(async () => JSON.stringify((await owner.get(path)).totals) === totals, 'the totals after a rebuild to stay what they were', 30_000);
}

async function revenuePage(page, chrome, m) {
  // The dev owner has no handle yet, and the app asks on load. "Not now" keeps it that way.
  const asking = page.getByRole('dialog', { name: 'Choose your handle' });
  await page.addLocatorHandler(asking, () => asking.getByRole('button', { name: 'Not now' }).click());
  await page.goto(`${chrome.origin}/admin`);
  const section = page.getByRole('region', { name: 'Revenue', exact: true });
  await see(section.getByRole('heading', { level: 2, name: 'Revenue' }), 'the Revenue heading');
  await see(section.getByText('Gross top-ups').first(), 'the takings');
  await see(section.getByText('Net revenue').first(), 'the net line');
  const form = section.getByRole('form', { name: 'Date range' });
  await form.getByLabel('From').fill('2031-01-02');
  await form.getByLabel('To').fill('2031-01-01');
  await see(form.getByText('From is after to.'), 'why the range is refused');
  assert.ok(await form.getByRole('button', { name: 'Show' }).isDisabled(), 'Show stays on with a bad range');
  await form.getByLabel('From').fill(day(Date.now() - 200 * 86_400_000));
  await form.getByLabel('To').fill(day(Date.now()));
  await form.getByLabel('By').selectOption('month');
  const [answered] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/admin/revenue'),
    form.getByRole('button', { name: 'Show' }).click(),
  ]);
  assert.equal(answered.status(), 200, 'the month read');
  assert.doesNotMatch(await section.innerText(), WORDS, 'an internal word in Revenue');
  m.revenue_page = 'figures, bad range, by month';
}

const traffic = (owner, who) => owner.get(`/admin/traffic?range=7d&class=${who}`);
const views = ({ headline: h }) => h.humans + h.agents_site + h.bots;

/** Page views carrying the mark leave nothing, in any class, at a path nobody else has. */
async function ownTraffic(owner, origin, m) {
  const before = await traffic(owner, 'bots');
  assert.equal(before.ok, true, `the Traffic report: ${JSON.stringify(before).slice(0, 200)}`);
  const path = `/kit-own-traffic-${Date.now().toString(36)}`;
  const marked = new Session(origin);
  for (let i = 0; i < MARKED_VIEWS; i += 1) await marked.raw('GET', path, undefined, { accept: 'text/html' });
  await sleep(SETTLE_MS);
  const after = [];
  for (const who of CLASSES) {
    const report = await traffic(owner, who);
    assert.ok(!report.traffic.top_pages.some((p) => p.key.startsWith(path)), `${path} is in ${who}'s top pages: our own traffic is counted`);
    after.push(report);
  }
  const grew = views(after[2].traffic) - views(before.traffic);
  assert.ok(grew < MARKED_VIEWS, `the counts grew by ${grew} after ${MARKED_VIEWS} marked views`);
  Object.assign(m, { own_traffic_marked: MARKED_VIEWS, own_traffic_counted_grew_by: grew, own_traffic_control: 'none: a tool may not send unmarked traffic' });
  return after[0].traffic;
}

async function trafficPage(page, chrome, t, m) {
  const [answered] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/admin/traffic'),
    page.goto(`${chrome.origin}/admin/traffic`),
  ]);
  assert.equal(answered.status(), 200, 'the Traffic read');
  await see(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Traffic' }), 'the Traffic tab');
  for (const tile of ['Humans', 'Agents', 'Bots']) await see(page.locator('.stat-card').filter({ hasText: tile }), `the ${tile} tile`);
  await see(page.getByRole('heading', { level: 2, name: 'Humans', exact: true }), 'the Humans chart');
  await page.getByRole('group', { name: /Whose pages/ }).getByRole('button', { name: 'Bots' }).click();
  await see(page.getByRole('heading', { name: 'Top paths' }), 'the Bots breakdown');
  m.traffic_counting = t.counting;
}

/** 39: `chrome` and `root`; `kitSession` is an account that is no operator. */
export async function adminPages({ chrome, kitSession, prod }, m) {
  if (prod) return { skip: 'Dev only: it reads the dev owner\'s pages' };
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = readEnvFile('dev-owner.env', { required: false });
  if (!username || !password) return { skip: 'No DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD in dev-owner.env' };
  const { origin, root } = chrome;
  const cookie = await ownerLogin(origin, username, password);
  try {
    const owner = new Session(`${origin}/api/v1`, { cookie });
    const read = await revenueApi(owner, kitSession, m);
    await rebuild(root, owner, read, m);
    const t = await ownTraffic(owner, origin, m);
    await withChrome({ ...chrome, cookie, name: 'admin-pages' }, m, async ({ page, shot }) => {
      await revenuePage(page, chrome, m);
      await shot('admin-revenue');
      await trafficPage(page, chrome, t, m);
      await shot('admin-traffic');
    });
  } finally {
    await new Session(origin, { cookie }).raw('POST', '/api/auth/logout').catch(() => {});
  }
}
