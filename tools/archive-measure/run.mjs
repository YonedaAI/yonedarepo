// One run of archive stage A's measurement: sizes before, the same work in each arm, sizes after
// everything it started has settled. The steps never read a size mid-work: a shard's copies go
// only after projection, so a size taken early would show savings that haven't happened.
import { b64 } from '../fanout-bench/driver.mjs';
import { stat } from '../fanout-bench/stats.mjs';
import { CHECK_NAME, POLICY, PROTECTED, requireMeasured } from './plan.mjs';

const AUTHOR = { name: 'Archive measure', email: 'bench@yonedarepo.invalid' };
const SETTLE_MS = 180_000;
const CHECK_MS = 300_000;
const IMPORT_MS = 20 * 60_000;
const LOOK_MS = 3000;
const SEGMENT_VERSIONS = 1024;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const serverTotal = (headers) => {
  const total = Number(headers?.get('server-timing')?.match(/total;dur=([\d.]+)/)?.[1]);
  return Number.isFinite(total) ? total : null;
};

/** A timed request; a refusal stops the run, because the rest of it would measure nothing. */
async function timed(api, method, path, body) {
  const answer = await api.raw(method, `/api/v1${path}`, body);
  if (!answer.ok) throw new Error(`${method} ${path.replace(/r[0-9a-f]{20}/, '<repo>')}: ${answer.status} ${answer.body?.error?.code ?? ''}`);
  return { body: answer.body, row: { status: answer.status, ms: Math.round(answer.ms), server: serverTotal(answer.headers) } };
}
const read = async (api, path) => (await timed(api, 'GET', path)).body;
const post = async (api, path, body) => (await timed(api, 'POST', path, body)).body;

/** One read of what a repository holds: the authority, all 64 shards, and its log. */
export async function sizes(api, repo) {
  const c = await read(api, `/repos/${repo}/compaction?shards=1`);
  if (!c.shards) throw new Error('This build has no shard sizes: deploy it first');
  return { authority: c.storage.db_bytes, shards: c.shards.db_bytes, git_bytes: c.storage.git_bytes ?? null, rows: c.storage.table_rows, shard_rows: c.shards.table_rows, head: c.head, floor: c.floor, tail_rows: c.tail_rows, keep_versions: c.retention?.keep_versions ?? null };
}

/** Sizes once no object waits to be stored and two reads in a row agree. */
export async function settled(api, repo, { limit = SETTLE_MS, look = LOOK_MS, wait = pause } = {}) {
  const deadline = Date.now() + limit;
  let last = null;
  for (;;) {
    const status = await read(api, `/repos/${repo}`);
    const quiet = (status.objects?.pending ?? 0) === 0;
    const now = await sizes(api, repo);
    const same = last && now.authority === last.authority && now.shards === last.shards;
    if (quiet && same) return { ...now, settled: true };
    if (Date.now() > deadline) return { ...now, settled: false };
    last = now;
    await wait(look);
  }
}

/** Branches at main's head, each then given a commit: a new agent branch, as it really starts. */
async function branches(api, repo, { run, count }) {
  const head = (await read(api, `/repos/${repo}/refs`)).refs?.['refs/heads/main'];
  const moves = [];
  const commits = [];
  for (let i = 0; i < count; i++) {
    const ref = `measure/${run}/${i}`;
    moves.push((await timed(api, 'POST', `/repos/${repo}/branches`, { ref, commit: head })).row);
    const change = { path: `measure/${run}/branch-${i}.txt`, content_b64: b64(`branch ${i}\n`) };
    commits.push((await timed(api, 'POST', `/repos/${repo}/commits`, { ref, changes: [change], message: `Branch ${i}`, author: AUTHOR })).row);
  }
  return { moves, commits };
}

/** Writers through the bench client, as a fleet lands: each its own token, all at once. */
async function landings(session, repo, { run, count }) {
  const label = `m${run}w`;
  const tokens = await session.mintTokens(repo, count, label);
  const writes = await session.fanout(repo, tokens.map((token, i) => ({ token, path: `measure/${run}/land-${i}.txt`, content: `landing ${i}\n` })));
  const left = await session.revokeTokens(repo, count, label);
  return { commits: writes.map((w) => w.commit), lands: writes.map((w) => w.land).filter(Boolean), tokens_left: left };
}

/** Check runs on landed commits: the bytes of evidence each stored, and that a reader finds them. */
async function checks(api, repo, commits, { limit = CHECK_MS, look = 5000, wait = pause } = {}) {
  const started = await Promise.all(commits.map(async (commit) => (await timed(api, 'POST', `/repos/${repo}/commits/${commit}/check-runs`, { name: CHECK_NAME })).body.runs[0].id));
  const deadline = Date.now() + limit;
  const done = new Map();
  while (done.size < started.length && Date.now() < deadline) {
    await wait(look);
    for (const id of started.filter((run) => !done.has(run))) {
      const run = await read(api, `/repos/${repo}/check-runs/${id}`);
      if (['passed', 'failed', 'errored'].includes(run.status)) done.set(id, run);
    }
  }
  const finished = [...done.values()];
  const logs = await Promise.all(finished.map((run) => api.raw('GET', `/api/v1/repos/${repo}/check-runs/${run.id}/log`)));
  return {
    asked: started.length,
    passed: finished.filter((r) => r.status === 'passed').length,
    evidence_bytes: finished.map((r) => (r.result === null || r.result === undefined ? 0 : JSON.stringify(r.result).length)),
    logs_readable: logs.filter((l) => l.ok).length,
  };
}

const delta = (before, after) => ({ authority: after.authority - before.authority, shards: after.shards - before.shards, settled: after.settled });
const landed = (work) => work.lands.filter((r) => r.status === 200).length;

/** One run of the arm's workload. `api` holds timing; `session` is a bench session. */
export async function measureRun({ api, session, repo, name, run, options, log = console.error, timing = {} }) {
  requireMeasured(name);
  const steps = {};
  const before = await settled(api, repo, timing);
  log(`run ${run}: ${options.branches} branches`);
  const branched = await branches(api, repo, { run, count: options.branches });
  const afterBranches = await settled(api, repo, timing);
  log(`run ${run}: ${options.landings} landings`);
  const work = await landings(session, repo, { run, count: options.landings });
  const afterLandings = await settled(api, repo, timing);
  const commits = [...new Set(work.commits.map((c) => c?.commit).filter(Boolean))].slice(0, options.checks);
  log(`run ${run}: ${commits.length} check runs`);
  const checked = await checks(api, repo, commits, timing);
  const afterChecks = await settled(api, repo, timing);
  steps.branches = { count: options.branches, bytes: delta(before, afterBranches), move: { server: stat(branched.moves, 'server'), client: stat(branched.moves, 'ms') }, commit: { server: stat(branched.commits, 'server'), client: stat(branched.commits, 'ms') } };
  steps.landings = { asked: options.landings, count: landed(work), bytes: delta(afterBranches, afterLandings), commit: { server: stat(work.commits, 'server'), client: stat(work.commits, 'ms') }, land: { server: stat(work.lands, 'server'), client: stat(work.lands, 'ms') }, tokens_left: work.tokens_left };
  steps.checks = checked;
  return { run, repo, name, before, after: afterChecks, steps };
}

/** Segments due now, from a read: what a daily sweep could move, and no more. */
export function sweepWouldMove({ tail_rows, keep_versions }) {
  if (!Number.isFinite(tail_rows) || !Number.isFinite(keep_versions)) return null;
  return Math.max(0, Math.floor((tail_rows - keep_versions) / SEGMENT_VERSIONS));
}

/** The owner's repositories as they stand, read and nothing else: what stage A can't touch. */
export async function baseline(api, repos) {
  const rows = [];
  for (const { id, name } of repos) {
    if (!PROTECTED.includes(name)) continue;
    const answer = await api.raw('GET', `/api/v1/repos/${id}/compaction?shards=1`);
    if (!answer.ok) {
      rows.push({ name, unreadable: answer.status });
      continue;
    }
    const c = answer.body;
    if (!c.shards) throw new Error('This build has no shard sizes: deploy it first');
    const row = { tail_rows: c.tail_rows, keep_versions: c.retention?.keep_versions };
    rows.push({ name, head: c.head, floor: c.floor, ...row, authority: c.storage.db_bytes, shards: c.shards.db_bytes, git_bytes: c.storage.git_bytes ?? null, rows: c.storage.table_rows, shard_rows: c.shards.table_rows, sweep_would_move: sweepWouldMove(row), held: c.held ?? null });
  }
  return rows;
}

/** An arm's repository: a fresh import of the real history, policy set. */
export async function importArm(api, { name, source, wait = pause, limit = IMPORT_MS }) {
  requireMeasured(name);
  const { id } = await post(api, '/repos/import', { url: `https://github.com/${source}.git`, name, visibility: 'private' });
  const deadline = Date.now() + limit;
  for (;;) {
    const state = await read(api, `/repos/${id}/import`);
    if (state.status === 'complete') break;
    if (['errored', 'terminated'].includes(state.status)) throw new Error(`The import ${state.status}: ${JSON.stringify(state.error)}`);
    if (Date.now() > deadline) throw new Error('The import ran past its limit');
    await wait(LOOK_MS);
  }
  await timed(api, 'PUT', `/repos/${id}/policy`, { policy: POLICY });
  return { id, name };
}
