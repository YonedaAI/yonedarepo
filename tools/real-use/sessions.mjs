// What people and agents do in a session, as ordinary code: each step is a request a client in
// their region sends, and `think` waits as they would. Nothing here knows how a step travels: the
// runner gives `a` (an actor) and the estimate plays the same scripts against a stub, so the
// request counts in the plan can't drift from the code. Checks are reports (`POST .../checks`),
// never container runs, and no script calls a model.
import { commitPack, cloneSteps, pushSteps } from '../fanout-bench/git-forms.mjs';

const AUTHOR = { name: 'Real use', email: 'bench@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');
const WORDS = ['file', 'retry', 'config', 'error', 'token', 'cache', 'merge', 'landing'];
const pick = (a, list) => list[Math.floor(a.random() * list.length)];
const chance = (a, p) => a.random() < p;
const between = (a, low, high) => low + Math.floor(a.random() * (high - low + 1));
const fileOf = (a) => pick(a, a.repo.paths);
const id = (a) => Math.floor(a.random() * 1e9).toString(36);

async function openHome(a) {
  await a.page([
    { label: 'page.html', path: '/' },
    ...a.assets.map((path) => ({ label: path.endsWith('.css') ? 'page.css' : 'page.js', path })),
    { label: 'repos.list', path: '/api/v1/repos' },
    { label: 'activity', path: '/api/v1/activity' },
  ]);
}

async function openRepo(a) {
  await a.page([
    { label: 'repo.status', path: `${a.api}` },
    { label: 'repo.refs', path: `${a.api}/refs` },
    { label: 'repo.tree', path: `${a.api}/tree?ref=main` },
    { label: 'repo.log', path: `${a.api}/log?limit=20` },
    { label: 'changes.list', path: `${a.api}/changes` },
  ]);
}

/** A person looks around a repository and reads a few files. */
async function browse(a) {
  await openHome(a);
  await a.think(5, 30);
  await openRepo(a);
  for (let i = between(a, 1, 5); i > 0; i--) {
    await a.think(5, 30);
    const path = fileOf(a);
    await a.step({ label: 'blob', path: `${a.api}/blob?path=${path}` });
    if (chance(a, 0.2)) await a.step({ label: 'blame', path: `${a.api}/blame?path=${path}` });
    if (chance(a, 0.2)) await a.step({ label: 'log.path', path: `${a.api}/log?path=${path}&limit=20` });
  }
}

/** A person reads an open Landing, comments and approves, and sometimes lands it. */
async function review(a) {
  await openHome(a);
  await a.think(5, 20);
  const list = await a.step({ label: 'changes.open', path: `${a.api}/changes?status=open`, keep: true });
  const open = (list.value?.changes ?? []).filter((c) => c.status === 'open' || c.state === 'open');
  if (!open.length) return;
  const { number } = pick(a, open);
  const change = await a.step({ label: 'change.page', path: `${a.api}/changes/${number}?patch=1`, keep: true });
  const head = change.value?.head;
  await a.think(20, 90);
  if (!head) return;
  if (chance(a, 0.5)) await a.step({ label: 'change.comment', path: `${a.api}/changes/${number}/comments`, json: { body: 'Why this way?' } });
  await a.think(10, 40);
  await a.step({ label: 'review', path: `${a.api}/commits/${head}/reviews`, json: { decision: 'approve' }, reviewer: true });
  await a.step({ label: 'change.gates', path: `${a.api}/changes/${number}/gates` });
  if (chance(a, 0.7)) await a.step({ label: 'land', path: `${a.api}/land`, json: { ref: 'main', commit: head } });
}

/** A person searches across their repositories and opens a hit. */
async function search(a) {
  await openHome(a);
  for (let i = between(a, 2, 4); i > 0; i--) {
    await a.think(5, 25);
    await a.step({ label: 'search.account', path: `/api/v1/search?q=${pick(a, WORDS)}` });
  }
  await a.think(3, 15);
  await a.step({ label: 'blob', path: `${a.api}/blob?path=${fileOf(a)}` });
}

/** An agent takes a task: reads, works, commits to a branch, records it, opens a Landing. */
async function agent(a) {
  const refs = await a.step({ label: 'repo.refs', path: `${a.api}/refs`, keep: true });
  const head = refs.value?.refs?.['refs/heads/main'];
  await a.step({ label: 'memories', path: `${a.api}/memories` });
  await a.step({ label: 'context', path: `${a.api}/context` });
  await a.think(2, 10);
  await a.step({ label: 'repo.tree', path: `${a.api}/tree?ref=main` });
  const read = [];
  for (let i = between(a, 3, 6); i > 0; i--) {
    await a.think(2, 8);
    read.push(fileOf(a));
    await a.step({ label: 'blob', path: `${a.api}/blob?path=${read.at(-1)}` });
  }
  await a.think(3, 15);
  await a.step({ label: 'search.repo', path: `${a.api}/search?q=${pick(a, WORDS)}` });
  await a.think(5, 30);
  if (!head) return;
  const branch = `agent/${id(a)}`;
  await a.step({ label: 'branch', path: `${a.api}/branches`, json: { ref: branch, commit: head, expected: null } });
  const changes = Array.from({ length: between(a, 1, 3) }, (_, i) => ({ path: `work/${id(a)}-${i}.txt`, content_b64: b64(`work ${id(a)}\n`) }));
  const made = await a.step({ label: 'commit', path: `${a.api}/commits`, keep: true, json: { ref: branch, changes, message: `Work on ${branch}`, author: AUTHOR, read_set: read } });
  const commit = made.value?.commit;
  if (!commit) return;
  await a.think(2, 10);
  await a.step({ label: 'session', path: `${a.api}/commits/${commit}/sessions`, json: { cli: 'real-use', model: 'none', summary: `Worked on ${branch}.` } });
  await a.step({ label: 'check', path: `${a.api}/commits/${commit}/checks`, json: { name: 'ci', status: 'pass', evidence: 'simulated' } });
  await a.think(2, 10);
  const opened = await a.step({ label: 'change.open', path: `${a.api}/changes`, keep: true, json: { branch, base: 'main', title: `Work on ${branch}`, body: 'From the real-use simulation.' } });
  if (chance(a, 0.1)) await a.step({ label: 'memory.add', path: `${a.api}/memories`, json: { kind: 'howto', text: `Work on ${branch} went through the usual path.` } });
  if (opened.ok && chance(a, 0.3)) {
    await a.think(5, 20);
    await a.step({ label: 'land', path: `${a.api}/land`, json: { ref: 'main', commit } });
  }
}

const rpc = (a, label, method, params) => a.step({ label, path: `${a.api}/mcp`, json: { jsonrpc: '2.0', id: 1, method, params }, headers: { accept: 'application/json' }, contains: '"result"' });

/** An agent's MCP session: connect, list tools, a run of reads. */
async function mcp(a) {
  await rpc(a, 'mcp.init', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'real-use', version: '1' } });
  await rpc(a, 'mcp.list', 'tools/list', {});
  for (let i = between(a, 3, 8); i > 0; i--) {
    await a.think(1, 6);
    const call = pick(a, [
      { name: 'git_ls_tree', arguments: { ref: 'main' } },
      { name: 'git_cat_file', arguments: { path: fileOf(a) } },
      { name: 'git_log', arguments: { limit: 20 } },
      { name: 'git_grep', arguments: { pattern: pick(a, WORDS) } },
    ]);
    await rpc(a, 'mcp.call', 'tools/call', call);
  }
}

/** A build job or a person's terminal: clone, and sometimes push a small branch. */
async function git(a) {
  await a.steps(cloneSteps(a.repo.id, a.credential, a.repo.seed_commit));
  await a.think(5, 20);
  await a.step({ label: 'repo.refs', path: `${a.api}/refs` });
  if (!chance(a, 0.4)) return;
  await a.think(10, 40);
  const name = `push-${id(a)}.txt`;
  const pushed = commitPack({ parent: a.repo.seed_commit, files: a.repo.blobs, name, text: `${name}\n`, at: 1_800_000_000 });
  await a.steps(pushSteps(a.repo.id, a.credential, { ref: `refs/heads/ci/${id(a)}`, ...pushed }));
}

export const SCRIPTS = { browse, review, search, agent, mcp, git };

/** How a step counts in the budget: `write` and `git` have longer targets than `read`. */
export function classOf(label) {
  if (/^(clone|push)\./.test(label)) return 'git';
  if (['commit', 'land', 'branch', 'session', 'check', 'review', 'memory.add'].includes(label) || label === 'change.open' || label === 'change.comment') return 'write';
  return 'read';
}
