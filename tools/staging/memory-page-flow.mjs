// Item 32 of the staging kit (no model): what a change shows of the session behind it. The real
// opencode plugin, with item 28's stand-in opencode context, starts a session on a branch of a
// new repository, is given a memory at the start and another when it reads the memory's file,
// pushes and ends; a change is opened for the branch. The change's sessions, then the
// session's record, transcript and context deliveries must read back through the API calls the
// pages make (ChangeSessions, SessionView). With `browser` (the live kit) headless Chrome then
// sees them: the session on the Change page, and the transcript and "Context delivered" on
// the page it links to, since neither is drawn on the Change page itself. The repository is
// deleted with the kit's others (item 17).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { MODEL, NO_SESSION, poll, withEnv } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { cookieHeader, signIn } from './browser-flow.mjs';
import { b64, Session } from './client.mjs';
import { fakeOpencode, modelCall } from './opencode-fake.mjs';
import { repoPath } from './repo-urls.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const FILE = 'src/net.ts';
const BRANCH = 'kit/page-evidence';
const PROMPT = 'Add jitter to the retry backoff';
const SESSION = 'kit-page';
const FIRST = 'Kit page memory: the land queue replays retry(), so it must stay idempotent.';
const SECOND = 'Kit page memory: src/net.ts is the only module allowed to open sockets.';
const SUMMARY = 'Kit page session: added jitter to the backoff in retry().';

/** The session, as the plugin drives it: start (first memory), read (second), push, end. */
async function session(kit, { api, repo, dir }) {
  const plugin = (await import(resolve(root, 'plugins/opencode/yoneda/index.ts'))).default;
  const env = { ...kit.env(NO_SESSION), YONEDA_BIN: join(kit.bin, 'yoneda') };
  return withEnv(env, async () => {
    const oc = fakeOpencode(dir, [
      { type: 'user', text: PROMPT },
      { type: 'assistant', model: { providerID: 'zai-coding-plan', id: 'glm-5.3' }, content: [{ type: 'text', text: SUMMARY }] },
    ]);
    const cleanup = await plugin.setup(oc.ctx);
    const call = modelCall(SESSION);
    await oc.hooks['session.context'](call);
    assert.ok(call.system[0]?.text.includes(FIRST), `the start context lacks the memory: ${call.system[0]?.text.slice(0, 400)}`);
    await api.post(`/repos/${repo}/memories`, { kind: 'constraint', text: SECOND, anchors: [{ path: FILE }] });
    await oc.hooks['tool.execute.after']({ tool: 'read', sessionID: SESSION, input: { path: FILE }, status: 'completed', result: { output: '…' } });
    await kit.ok('git', ['switch', '-q', '-c', BRANCH], { cwd: dir });
    writeFileSync(join(dir, FILE), 'export function retry() { /* jitter */ }\n');
    await kit.gitOk(dir, 'commit', '-qam', 'Add jitter');
    await kit.ok('git', ['push', '-q', 'origin', BRANCH], { cwd: dir, env: kit.env({ ...NO_SESSION, OPENCODE_SESSION_ID: SESSION }) });
    const head = await kit.gitOk(dir, 'rev-parse', 'HEAD');
    oc.emit({ type: 'session.execution.succeeded', data: { sessionID: SESSION } });
    await poll(async () => (await api.get(`/repos/${repo}/commits/${head}/sessions`)).sessions.length > 0, 'the session record');
    await cleanup();
    return head;
  });
}

/** What the pages read for change `number`, asserted; returns the session's id. */
async function pageReads(api, repo, { head, base }, metrics) {
  const change = await api.get(`/repos/${repo}/changes/${metrics.change}`);
  assert.equal(change.head, head, "the change's head is the pushed commit");
  const listed = (await api.get(`/repos/${repo}/sessions?${new URLSearchParams({ head, base, limit: '200' })}`)).sessions;
  const record = listed.find((s) => s.session_id === `opencode:${SESSION}`);
  assert.ok(record, `the change lists no session: ${JSON.stringify(listed).slice(0, 300)}`);
  assert.deepEqual([record.cli, record.model, record.summary], ['opencode', MODEL, SUMMARY], 'the session record');
  const detail = await api.get(`/repos/${repo}/sessions/${record.id}`);
  assert.equal(detail.commit?.id ?? detail.session?.commit, head, "the session's commit");
  const { document: stored } = await api.get(`/repos/${repo}/sessions/${record.id}/transcript`);
  const turns = stored.turns.map((t) => [t.kind, t.text]);
  assert.deepEqual(turns, [['prompt', PROMPT], ['reply', SUMMARY]], 'the transcript');
  assert.ok(stored.context?.includes(FIRST), 'the transcript keeps the context the session started with');
  const delivered = (await api.get(`/repos/${repo}/context/deliveries?session_id=${encodeURIComponent(`opencode:${SESSION}`)}`)).deliveries;
  assert.ok(delivered.find((d) => d.trigger === 'start')?.items.some((i) => i.label?.includes(FIRST)), 'the start delivery names the first memory');
  assert.ok(delivered.find((d) => d.trigger === 'read' && d.subject === FILE)?.items.some((i) => i.label?.includes(SECOND)), 'the read delivery names the second memory');
  Object.assign(metrics, { session: record.id, deliveries: delivered.map((d) => d.trigger).join(','), transcript_turns: turns.length });
}

/** The same three in the served app. */
async function pagesInChrome({ origin, kit: login, headed }, repo, number, metrics) {
  const dir = resolve(root, `.local/staging/memory-page-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  metrics.evidence = dir;
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await signIn(page, origin, login);
    const account = new Session(origin, { cookie: cookieHeader(await context.cookies(origin)) });
    await page.goto(`${origin}${await repoPath(account, repo)}/changes/${number}`);
    const sessions = page.getByRole('region', { name: 'Sessions behind this change' });
    await see(sessions.getByText(SUMMARY), 'the session on the Change page');
    await page.screenshot({ path: join(dir, 'change.png'), fullPage: true });
    await sessions.getByRole('link', { name: /opencode/ }).first().click();
    const detail = page.locator('article.agent-session');
    await see(detail.getByRole('heading', { name: 'Context delivered' }), 'the delivered context');
    await see(detail.getByText(FIRST).first(), 'the start delivery');
    await see(detail.getByText(SECOND).first(), 'the read delivery');
    await see(detail.getByText(PROMPT).first(), "the transcript's prompt");
    await see(detail.locator('.agent-turn-reply').getByText(SUMMARY), "the transcript's reply");
    await page.screenshot({ path: join(dir, 'session.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}

/** 32: `browser`: `{ origin, kit, headed }` for the served app; without it, the API half. */
export async function memoryPage(kit, { browser }, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const api = kit.pat();
  const name = `kit-memory-page-${Date.now()}`;
  const created = await api.post('/repos', { name, policy: { approvals: 0, required_checks: [] }, files: [{ path: FILE, content_b64: b64('export function retry() {}\n') }], author });
  const repo = created.id;
  kit.repos.push({ id: repo, name });
  metrics.repo = repo;
  const dir = kit.path('memory-page');
  await kit.ok('git', ['clone', '-q', kit.remote(repo), dir]);
  await api.post(`/repos/${repo}/memories`, { kind: 'gotcha', text: FIRST, anchors: [{ path: FILE }] });
  const base = (await api.get(`/repos/${repo}/refs`)).refs['refs/heads/main'];
  const head = await session(kit, { api, repo, dir });
  const change = await api.post(`/repos/${repo}/changes`, { branch: BRANCH, title: 'Kit page evidence' });
  metrics.change = change.number;
  await pageReads(api, repo, { head, base }, metrics);
  if (browser) await pagesInChrome(browser, repo, change.number, metrics);
  else metrics.browser = 'not run';
}
