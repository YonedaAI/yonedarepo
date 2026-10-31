// The first half of an import that shows its code first (`FAST_IMPORT=on`): Artifacts is
// asked for the remote, and main lands at the remote's head as soon as it has it. Run from the
// import's request (`startImport`), then again by its Workflow, which finds it done: every
// part repeats harmlessly. repo-import-fill.ts records the history behind it. With
// `DIRECT_IMPORT` on, the request also fetches the remote itself and main may land first that
// way (repo-import-direct): the same steps then find it landed.
import { NonRetryableError } from 'cloudflare:workflows';
import { rpcValue } from './durable';
import { directImport, directOn } from './repo-import-direct';
import { moveMirror } from './repo-import-mirror';
import { diff, parentTree, type Repo, tooLarge, treeReader } from './repo-import-trees';
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
/** From the request to main usable, stage by stage, as the bench reports it. */
export type Timing = Json & { usable_ms: number };
/** The subset of WorkflowStep the import uses (tests pass a direct runner). */
export type ImportStep = {
  do<T>(name: string, config: Json, callback: () => Promise<T>): Promise<T>;
};

export const RETRY = {
  retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
export const storeName = (repo: string) => `yr-${repo}`;

const LOG_PAGE = 1000;
const POLL_MS = 250;

export const logged = (c: ArtifactsCommitMetadata): Commit => ({
  hash: c.hash,
  tree: c.treeHash,
  parents: c.parents,
  message: c.message.slice(0, 4000),
});

/** Answers that mean a fetch of this repository already ran or runs. */
const FETCHED = new Set(['ALREADY_EXISTS', 'IMPORT_IN_PROGRESS']);
/** Artifacts' refusals that no retry mends. */
const FINAL = [
  'NOT_FOUND',
  'INVALID_INPUT',
  'INVALID_URL',
  'INVALID_REPO_NAME',
  'REMOTE_AUTH_REQUIRED',
  'MEMORY_LIMIT',
];
const final = (e: any) =>
  FINAL.includes(e?.code) ? new NonRetryableError(`${e.code}: ${e?.message ?? e}`) : e;

/** Asks Artifacts to fetch the remote; one already fetching or fetched is that fetch. */
export async function fetchRemote(env: Env, params: ImportParams) {
  try {
    await rpcValue(
      env.ARTIFACTS.import({
        source: { url: params.url, ...(params.branch ? { branch: params.branch } : {}) },
        target: { name: storeName(params.repo) },
      }),
    );
  } catch (e: any) {
    if (!FETCHED.has(e?.code)) throw final(e);
  }
}

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

/** Main's commit, when a direct import landed it. The remote may have moved on since, so
 * that Artifacts has another tip; main stays what was fetched and the mirror is moved to it. */
async function landedHead(env: Env, params: ImportParams) {
  if (!directOn(env, params.url)) return null;
  const { refs } = await caller(env, params.repo, { _system: 'import' })({ op: 'repo_status' });
  const main = (refs as Json[]).find((r) => r.name === 'refs/heads/main');
  return (main?.commit_id as string | undefined) ?? null;
}

export async function landHead(env: Env, params: ImportParams) {
  using repo = await whenImported(env, params);
  const fetched_at = Date.now();
  // The branch Artifacts imported: the one named, else the store's own default.
  const ref = params.branch ?? (await rpcValue(repo.info())).defaultBranch;
  // One past the limit: the oldest kept commit's changes are against its real parent.
  let chain = await readChain(repo, ref, params.max + 1);
  const direct = await landedHead(env, params);
  if (direct && chain[0] && direct !== chain[0].hash) {
    if (ref === 'main') await moveMirror(env, params, chain[0].hash, direct);
    chain = await readChain(repo, direct, params.max + 1);
  }
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
  // Landed already (a retry, or the request and the Workflow both here): that one stands.
  const landed = await call({ op: 'repo_import', ref: 'main', commit: head.hash }).catch((e) => {
    if (e?.code !== 'ALREADY_EXISTS') throw e;
    return call({ op: 'repo_status' });
  });
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
export const stopReason = (e: unknown) =>
  tooLarge(e)
    ? 'One commit changes more than 10,000 files.'
    : 'Recording older commits kept failing.';

/** Ends history where it reached, leaving the repository as a capped import would. */
export async function endHistory(env: Env, params: ImportParams, why: Json) {
  const call = caller(env, params.repo, { _system: 'import' });
  const { history_stopped } = await call({ op: 'repo_record_imported_end', ...why });
  return history_stopped as { recorded: number; total: number; reason: string } | null;
}

/** For a step whose failure leaves Artifacts without this history for good: main may have
 * landed without it (a direct import), and history below that must not wait on it. */
export const endWithoutMirror =
  (env: Env, params: ImportParams, step: ImportStep) =>
  async (e: unknown): Promise<never> => {
    if (directOn(env, params.url))
      await step.do('end history here', RETRY, () =>
        endHistory(env, params, { reason: 'The object store could not take this history.' }),
      );
    throw e;
  };

type Landed = Awaited<ReturnType<typeof landHead>>;
/** Where a request that landed its import's head leaves that run's timing. */
export const headKey = (repo: string) => `platform/v1/${repo}/import-head.json`;
/** What starts the import's Workflow, until it has run (repo-import-start). */
export const askedKey = (repo: string) => `platform/v1/${repo}/import-asked.json`;

/** From the request to main usable, stage by stage. */
export const headTiming = (
  params: ImportParams,
  importing_at: number,
  head: Landed,
  landed_by: 'request' | 'workflow',
) => ({
  landed_by,
  start_ms: importing_at - (params.asked_at ?? importing_at),
  artifacts_ms: head.fetched_at - importing_at,
  chain_ms: head.read_at - head.fetched_at,
  land_ms: head.landed_at - head.read_at,
  usable_ms: head.landed_at - (params.asked_at ?? importing_at),
});

/** The first half of an import, run from its request so that main does not wait for a
 * Workflow to start (1-4 s on dev): ask Artifacts for the remote, and land its head. Every
 * part of it repeats harmlessly, and the Workflow repeats it all: the request has 30 s after
 * its answer, and what it does not reach, the Workflow does. */
export async function startImport(env: Env, params: ImportParams) {
  const importing_at = Date.now();
  // Beside Artifacts' own fetch, racing it to main: whichever lands first, the other finds it.
  const direct = directOn(env, params.url)
    ? directImport(env, params).then(async (timing) => {
        if (timing) await env.OBJECTS.put(headKey(params.repo), JSON.stringify(timing));
        return timing;
      })
    : null;
  try {
    await fetchRemote(env, params);
    const head = await landHead(env, params);
    if (await direct) return;
    const timing = headTiming(params, importing_at, head, 'request');
    await env.OBJECTS.put(headKey(params.repo), JSON.stringify(timing));
  } finally {
    await direct;
  }
}
