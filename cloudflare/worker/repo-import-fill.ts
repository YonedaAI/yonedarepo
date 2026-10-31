// An import that shows its code first (`FAST_IMPORT=on`): main lands at the remote's head as
// soon as Artifacts has it, then the first-parent history fills in behind it, newest first
// (repo_store/history_fill.rs says what reads and writes see meanwhile). What today's path
// spends goes (docs/load-testing.md): a Workflow lends no waitUntil, so each tree read down
// every tier also waited for its R2 and edge copies. Here trees come straight from
// Artifacts over one handle, in parallel, and each wave of commits is one Workflow step:
// one log call, one read per new tree, and one authority transaction per bounded batch.
// Every step can repeat: a head already landed stays, and the authority skips commits it
// already holds and refuses any that would leave a gap.
import { NonRetryableError } from 'cloudflare:workflows';
import { rpcValue } from './durable';
import { inBatches } from './repo-git-objects';
import {
  changedPaths,
  diff,
  parentTree,
  type Repo,
  tooLarge,
  treeReader,
} from './repo-import-trees';
import { caller, type Json } from './repo-ops';
import { dispatchProjection } from './repo-projection';
import type { Env } from './types';

/** `branch`: the remote's branch to import; none: its default branch. */
export type ImportParams = {
  repo: string;
  url: string;
  branch?: string;
  max: number;
  /** When the request asked, for the import's own timing. */
  asked_at?: number;
};
export type Commit = { hash: string; tree: string; parents: string[]; message: string };
/** The subset of WorkflowStep the import uses (tests pass a direct runner). */
export type ImportStep = {
  do<T>(name: string, config: Json, callback: () => Promise<T>): Promise<T>;
};

export const RETRY = {
  retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
/** A wave retries for about 2.5 minutes: past that, the repository matters more. */
const WAVE_RETRY = {
  retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
export const storeName = (repo: string) => `yr-${repo}`;

/** Commits per wave, the authority's most per transaction (BATCH_COMMITS). */
const WAVE = 250;
/** Commits diffed at once. */
const DIFFS = 32;
/** JSON one authority call carries (one larger commit goes alone). */
const BATCH_BYTES = 1024 * 1024;
const LOG_PAGE = 1000;
const POLL_MS = 500;

export { changedPaths };

export const logged = (c: ArtifactsCommitMetadata): Commit => ({
  hash: c.hash,
  tree: c.treeHash,
  parents: c.parents,
  message: c.message.slice(0, 4000),
});

/** The chain from `ref`, newest first, at most `want` commits. */
async function readChain(repo: Repo, ref: string, want: number) {
  const chain: Commit[] = [];
  while (chain.length < want) {
    const last = chain.at(-1)?.hash;
    const limit = Math.min(LOG_PAGE, want - chain.length);
    const page = await rpcValue(repo.log({ ref: last ?? ref, limit, offset: last ? 1 : 0 }));
    chain.push(...page.map(logged));
    if (page.length < limit) break;
  }
  return chain;
}

/** The repository's store once Artifacts has finished: asked often, not at the backoff a
 * failed step gets, which would leave the code hidden for minutes after it arrived. */
async function whenImported(env: Env, params: ImportParams) {
  for (;;) {
    try {
      return await env.ARTIFACTS.get(storeName(params.repo));
    } catch (e: any) {
      if (e?.code !== 'IMPORT_IN_PROGRESS') throw e;
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

async function landHead(env: Env, params: ImportParams) {
  using repo = await whenImported(env, params);
  const fetched_at = Date.now();
  // The branch Artifacts imported: the one named, else the store's own default.
  const ref = params.branch ?? (await rpcValue(repo.info())).defaultBranch;
  // One past the limit: the oldest kept commit's changes are against its real parent.
  const chain = await readChain(repo, ref, params.max + 1);
  const read_at = Date.now();
  const [head, below] = chain;
  if (!head)
    throw new NonRetryableError(
      params.branch ? `Branch ${params.branch} has no commits` : 'The remote has no commits',
    );
  const whole = Math.min(chain.length, params.max);
  // A head too large to record its changes still lands: it is all the history there will be.
  const touches = await diff(
    treeReader(repo),
    await parentTree(repo, head, below),
    head.tree,
  ).catch((e) => {
    if (!tooLarge(e)) throw e;
    return null;
  });
  const total = touches ? whole : 1;
  const call = caller(env, params.repo, { _system: 'import' });
  await call({
    op: 'repo_record_imported',
    commit: head.hash,
    tree: head.tree,
    parents: head.parents,
    message: head.message,
    generation: total,
    touches: touches ?? [],
  });
  const status = await call({ op: 'repo_status' });
  const landed = status.refs.length
    ? status
    : await call({ op: 'repo_import', ref: 'main', commit: head.hash });
  // Imported as main, the store already holds main at this commit, and projecting it as a new
  // ref is refused as stale. Any other branch leaves main for projection to create.
  if ((params.branch ?? 'main') === 'main')
    await caller(env, params.repo, { _system: 'projection' })({
      op: 'repo_projection_result',
      refname: 'refs/heads/main',
      version: landed.version,
      outcome: 'ok',
      commit: head.hash,
    });
  // Now, not after the history: a clone through the store needs main there.
  else await dispatchProjection(env, params.repo);
  const stopped = touches
    ? null
    : await endHistory(env, params, { reason: stopReason(TOO_LARGE), total: whole });
  const landed_at = Date.now();
  return {
    commit: head.hash,
    version: landed.version as number,
    total,
    stopped,
    next: total > 1 ? { commit: below?.hash as string, generation: total - 1 } : null,
    fetched_at,
    read_at,
    landed_at,
  };
}

const TOO_LARGE = new Error('TOO_LARGE: ');
/** Why history ended early, as the repository's page says it. */
const stopReason = (e: unknown) =>
  tooLarge(e)
    ? 'One commit changes more than 10,000 files.'
    : 'Recording older commits kept failing.';

/** Ends history where it reached, leaving the repository as a capped import would. */
async function endHistory(env: Env, params: ImportParams, why: Json) {
  const call = caller(env, params.repo, { _system: 'import' });
  const { history_stopped } = await call({ op: 'repo_record_imported_end', ...why });
  return history_stopped as { recorded: number; total: number; reason: string } | null;
}

type Cursor = { commit: string; generation: number };

/** Splits `commits` so one call's JSON stays within `BATCH_BYTES`. */
function batches(commits: Json[]) {
  const out: Json[][] = [];
  let bytes = 0;
  for (const commit of commits) {
    const size = JSON.stringify(commit).length;
    if (out.length === 0 || bytes + size > BATCH_BYTES) {
      out.push([]);
      bytes = 0;
    }
    out[out.length - 1].push(commit);
    bytes += size;
  }
  return out;
}

/** Records the next `WAVE` commits from `at` down, and says where the next wave starts. */
async function recordWave(env: Env, params: ImportParams, at: Cursor) {
  const started = Date.now();
  using repo = await env.ARTIFACTS.get(storeName(params.repo));
  const page = (await rpcValue(repo.log({ ref: at.commit, limit: WAVE + 1 }))).map(logged);
  const logged_at = Date.now();
  const wave = page.slice(0, Math.min(WAVE, at.generation));
  const read = treeReader(repo);
  const diffed = await inBatches(
    wave.map((_, i) => i),
    DIFFS,
    async (i) => ({
      commit: wave[i].hash,
      tree: wave[i].tree,
      parents: wave[i].parents,
      message: wave[i].message,
      generation: at.generation - i,
      touches: await diff(read, await parentTree(repo, wave[i], page[i + 1]), wave[i].tree).catch(
        (e) => {
          if (!tooLarge(e)) throw e;
          return null;
        },
      ),
    }),
  );
  // What lies above a commit too large to record is still history.
  const stop = diffed.findIndex((commit) => !commit.touches);
  const commits = stop < 0 ? diffed : diffed.slice(0, stop);
  const diffed_at = Date.now();
  const call = caller(env, params.repo, { _system: 'import' });
  for (const batch of batches(commits))
    await call({ op: 'repo_record_imported_batch', commits: batch });
  if (stop >= 0) throw new NonRetryableError(`TOO_LARGE: ${wave[stop].hash}`);
  const left = at.generation - wave.length;
  return {
    next: left > 0 ? { commit: page[wave.length].hash, generation: left } : null,
    commits: wave.length,
    log_ms: logged_at - started,
    trees_ms: diffed_at - logged_at,
    authority_ms: Date.now() - diffed_at,
  };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** `importing_at`: when Artifacts was asked to fetch the remote. */
export async function landThenFill(
  env: Env,
  params: ImportParams,
  step: ImportStep,
  importing_at: number,
) {
  const head = await step.do('land the head', RETRY, () => landHead(env, params));
  const rates: number[] = [];
  const spent = { log_ms: [] as number[], trees_ms: [] as number[], authority_ms: [] as number[] };
  let next: Cursor | null = head.next;
  let stopped = head.stopped;
  try {
    while (next) {
      const at: Cursor = next;
      const wave = await step.do(`record commits below ${at.generation + 1}`, WAVE_RETRY, () =>
        recordWave(env, params, at),
      );
      const { log_ms, trees_ms, authority_ms } = wave;
      spent.log_ms.push(log_ms);
      spent.trees_ms.push(trees_ms);
      spent.authority_ms.push(authority_ms);
      rates.push(Math.round((wave.commits * 1000) / (log_ms + trees_ms + authority_ms + 1)));
      next = wave.next;
    }
  } catch (e) {
    // Retries are spent, or none can help: the repository must not wait on history.
    console.warn(`history import ended early: ${params.repo}: ${e}`);
    const reason = stopReason(e);
    stopped = await step.do('end history here', RETRY, () => endHistory(env, params, { reason }));
  }
  const filled = await step.do('finish', RETRY, async () => Date.now());
  rates.sort((a, b) => a - b);
  const history_ms = filled - head.landed_at;
  return {
    commit: head.commit,
    version: head.version,
    commits: stopped?.recorded ?? head.total,
    ...(stopped && { stopped }),
    // What the bench reports (tools/import-bench.mjs): server-side, in the Workflow's steps.
    timing: {
      // From the request to main usable, stage by stage.
      start_ms: importing_at - (params.asked_at ?? importing_at),
      artifacts_ms: head.fetched_at - importing_at,
      chain_ms: head.read_at - head.fetched_at,
      land_ms: head.landed_at - head.read_at,
      usable_ms: head.landed_at - (params.asked_at ?? importing_at),
      history_ms,
      commits_per_s: Math.round(((head.total - 1) * 1000) / (history_ms + 1)),
      waves: rates.length,
      wave_commits_per_s: {
        min: rates[0] ?? null,
        median: rates[rates.length >> 1] ?? null,
        max: rates.at(-1) ?? null,
      },
      log_ms: sum(spent.log_ms),
      trees_ms: sum(spent.trees_ms),
      authority_ms: sum(spent.authority_ms),
    },
  };
}
