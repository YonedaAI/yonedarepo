// Imports an external Git repository: Artifacts fetches it into the repository's object
// store, then its first-parent history (up to a limit) is recorded with file-level
// changes and the branch (the remote's default unless one is named) lands as main. Every
// step is idempotent so a Workflow can retry it; a failure retrying cannot mend (no such
// remote or branch, no access) fails the import at once, with Artifacts' reason.
import { NonRetryableError } from 'cloudflare:workflows';
import { rpcValue } from './durable';
import { parseStore, RepoObjects } from './repo-objects';
import { caller, type Json, withTrees } from './repo-ops';
import type { Env } from './types';

/** `branch`: the remote's branch to import; none: its default branch. */
export type ImportParams = { repo: string; url: string; branch?: string; max: number };
type Commit = { hash: string; tree: string; parents: string[]; message: string };
/** The subset of WorkflowStep the import uses (tests pass a direct runner). */
export type ImportStep = {
  do<T>(name: string, config: Json, callback: () => Promise<T>): Promise<T>;
};

const RETRY = {
  retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
const BATCH = 20;

const storeName = (repo: string) => `yr-${repo}`;

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

async function readHistory(env: Env, params: ImportParams): Promise<Commit[]> {
  using repo = await env.ARTIFACTS.get(storeName(params.repo));
  // The branch Artifacts imported: the one named, else the remote's default.
  const branch = params.branch ?? (await rpcValue(repo.info())).defaultBranch;
  const newestFirst: Commit[] = [];
  while (newestFirst.length < params.max) {
    const page = await rpcValue(
      repo.log({
        ref: branch,
        limit: Math.min(1000, params.max - newestFirst.length),
        offset: newestFirst.length,
      }),
    );
    if (page.length === 0) break;
    for (const c of page)
      newestFirst.push({
        hash: c.hash,
        tree: c.treeHash,
        parents: c.parents,
        message: c.message.slice(0, 4000),
      });
  }
  if (newestFirst.length === 0) throw new NonRetryableError(`Branch ${branch} has no commits`);
  return newestFirst.reverse();
}

async function recordBatch(env: Env, params: ImportParams, batch: Commit[], previous?: Commit) {
  const call = caller(env, params.repo, { _system: 'import' });
  const objects = new RepoObjects(
    env,
    params.repo,
    parseStore(env, `artifacts:${env.ARTIFACTS_NAMESPACE}/${storeName(params.repo)}`),
  );
  let parent = previous;
  for (const commit of batch) {
    let parentTree: string | null = null;
    if (commit.parents[0])
      parentTree =
        parent?.hash === commit.parents[0]
          ? parent.tree
          : ((await objects.store.readCommit(commit.parents[0]))?.tree ?? null);
    const { changes } = await withTrees(objects, {
      op: 'tree_diff',
      old: parentTree,
      new: commit.tree,
    });
    await call({
      op: 'repo_record_imported',
      commit: commit.hash,
      tree: commit.tree,
      parents: commit.parents,
      message: commit.message,
      touches: changes.map((c: Json) => ({
        path: c.path,
        op: c.op,
        old_blob: c.old?.id ?? null,
        new_blob: c.new?.id ?? null,
      })),
    });
    parent = commit;
  }
  return batch.length;
}

export async function runImport(env: Env, params: ImportParams, step: ImportStep) {
  await step.do('import into the object store', RETRY, async () => {
    try {
      await rpcValue(
        env.ARTIFACTS.import({
          source: { url: params.url, ...(params.branch ? { branch: params.branch } : {}) },
          target: { name: storeName(params.repo) },
        }),
      );
    } catch (e: any) {
      if (e?.code !== 'ALREADY_EXISTS') throw final(e);
    }
    return true;
  });
  // Throws IMPORT_IN_PROGRESS until Artifacts finishes; the step retries with backoff.
  const history = await step.do('read history', RETRY, () => readHistory(env, params));
  for (let start = 0; start < history.length; start += BATCH)
    await step.do(`record commits ${start}`, RETRY, () =>
      recordBatch(env, params, history.slice(start, start + BATCH), history[start - 1]),
    );
  return step.do('land the imported branch', RETRY, async () => {
    const call = caller(env, params.repo, { _system: 'import' });
    const head = history[history.length - 1].hash;
    const status = await call({ op: 'repo_status' });
    if (status.refs.length > 0) return { commit: head, version: status.version };
    const landed = await call({ op: 'repo_import', ref: 'main', commit: head });
    return { commit: head, version: landed.version, commits: history.length };
  });
}
