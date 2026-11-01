// An import that shows its code first (`FAST_IMPORT=on`): main lands at the remote's head as
// soon as Artifacts has it, then the first-parent history fills in behind it, newest first
// (repo_store/history_fill.rs says what reads and writes see meanwhile). What today's path
// spends goes (docs/load-testing.md): a Workflow lends no waitUntil, so each tree read down
// every tier also waited for its R2 and edge copies. Here trees come straight from
// Artifacts over one handle, in parallel, and each wave of commits is one Workflow step:
// one log call, one read per new tree, and one authority transaction per bounded batch.
// Every step can repeat: a head already landed stays, and the authority skips commits it
// already holds and refuses any that would leave a gap. With a pack a direct import stored
// (repo-import-direct), one step reads every tree from it and no waves run.

import { NonRetryableError } from 'cloudflare:workflows';
import { rpcValue } from './durable';
import { log } from './log';
import { inBatches } from './repo-git-objects';
import { directOn, fetchedPack, wholeClone } from './repo-import-direct';
import {
  askedKey,
  endHistory,
  endWithoutMirror,
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
import { bandOne } from './repo-mirror-git';
import { caller, type Json } from './repo-ops';
import { packKey, storedPack } from './repo-pack-cache';
import { copyHeader } from './repo-pack-copy';
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

/** Records the history below `head` from the pack a direct import stored (no tree is read
 * from Artifacts, one step, so a retry starts again and the authority skips what it holds),
 * or answers null when there is no such pack and the waves do it. */
async function fillFromPack(
  env: Env,
  params: ImportParams,
  head: { commit: string; total: number },
) {
  const started = Date.now();
  const stored = await storedPack(env, await packKey(params.repo, wholeClone([head.commit])));
  if (!stored) return null;
  const call = caller(env, params.repo, { _system: 'import' });
  const copy = fetchedPack(env, params.repo);
  try {
    await copy.feed(copyHeader(head.commit));
    const none = { shallow: [], unshallow: [] };
    for await (const piece of bandOne(stored.body, none, false, true)) await copy.feed(piece);
    // What a stored pack cannot give now it never will: the waves read Artifacts instead.
    const read = (input: Json) => {
      try {
        return copy.call(input);
      } catch (e: any) {
        throw new NonRetryableError(`The pack cannot be read: ${e?.message ?? e}`);
      }
    };
    read({ op: 'finish' });
    read({ op: 'import_chain', tip: head.commit, max: params.max });
    let authority_ms = 0;
    const read_at = Date.now();
    for (let from = 1; from < head.total; from += WAVE) {
      const commits: Json[] = read({ op: 'import_commits', from, count: WAVE }).commits;
      const stop = commits.findIndex((commit) => !commit.touches);
      const recorded = Date.now();
      for (const batch of batches(stop < 0 ? commits : commits.slice(0, stop)))
        await call({ op: 'repo_record_imported_batch', commits: batch });
      authority_ms += Date.now() - recorded;
      if (stop >= 0) throw new NonRetryableError(`TOO_LARGE: ${commits[stop].commit}`);
    }
    return {
      log_ms: read_at - started,
      trees_ms: Date.now() - read_at - authority_ms,
      authority_ms,
    };
  } finally {
    await copy.close();
  }
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** `importing_at`: when Artifacts was asked to fetch the remote. */
export async function landThenFill(
  env: Env,
  params: ImportParams,
  step: ImportStep,
  importing_at: number,
) {
  const head = await step
    .do('land the head', RETRY, () => landHead(env, params))
    .catch(endWithoutMirror(env, params, step));
  const rates: number[] = [];
  const spent = { log_ms: [] as number[], trees_ms: [] as number[], authority_ms: [] as number[] };
  let next: Cursor | null = head.next;
  let stopped = head.stopped;
  try {
    if (next && directOn(env, params.url)) {
      const packed = await step
        .do('record history from the pack', WAVE_RETRY, () => fillFromPack(env, params, head))
        .catch((e) => {
          if (tooLarge(e)) throw e;
          log.warn('import.history_not_recorded', { repo: params.repo, error: e });
          return null;
        });
      if (packed) {
        spent.log_ms.push(packed.log_ms);
        spent.trees_ms.push(packed.trees_ms);
        spent.authority_ms.push(packed.authority_ms);
        next = null;
      }
    }
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
    log.warn('import.history_ended_early', { repo: params.repo, error: e });
    const reason = stopReason(e);
    stopped = await step.do('end history here', RETRY, () => endHistory(env, params, { reason }));
  }
  const { filled, early } = await step.do('finish', RETRY, async () => {
    const key = headKey(params.repo);
    const noted = await env.OBJECTS.get(key);
    const early = noted ? await noted.json<Json>() : null;
    await env.OBJECTS.delete([key, askedKey(params.repo)]);
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
      workflow_ms: importing_at - (params.asked_at ?? importing_at),
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
