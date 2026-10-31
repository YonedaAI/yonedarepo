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
  endHistory,
  headKey,
  headTiming,
  type ImportParams,
  type ImportStep,
  landHead,
  logged,
  RETRY,
  stopReason,
  storeName,
} from './repo-import-head';
import { diff, parentTree, tooLarge, treeReader } from './repo-import-trees';
import { caller, type Json } from './repo-ops';
import type { Env } from './types';

/** A wave retries for about 2.5 minutes: past that, the repository matters more. */
const WAVE_RETRY = {
  retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
/** Commits per wave, the authority's most per transaction (BATCH_COMMITS). */
const WAVE = 250;
/** Commits diffed at once. */
const DIFFS = 32;
/** JSON one authority call carries (one larger commit goes alone). */
const BATCH_BYTES = 1024 * 1024;
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
  const { filled, early } = await step.do('finish', RETRY, async () => {
    const key = headKey(params.repo);
    const noted = await env.OBJECTS.get(key);
    const early = noted ? await noted.json<Json>() : null;
    await env.OBJECTS.delete(key);
    return { filled: Date.now(), early };
  });
  rates.sort((a, b) => a - b);
  const history_ms = filled - head.landed_at;
  return {
    commit: head.commit,
    version: head.version,
    commits: stopped?.recorded ?? head.total,
    ...(stopped && { stopped }),
    // What the bench reports (tools/import-bench.mjs): server-side, in the Workflow's steps.
    timing: {
      ...(early ?? headTiming(params, importing_at, head, 'workflow')),
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
