// An import's Workflow, and what `GET /repos/<id>/import` says of it. The Workflow records
// history and finishes what the request began, but a direct import lands main without it, and
// a Workflow takes seconds to start (docs/direct-import.md), so that request does not wait for
// one (`DIRECT_IMPORT`): what starts it is kept in R2 first, it is created behind the answer,
// and a look at the import starts it again if that failed. A second create finds the first.
// Until it exists the import reads as `queued`, never as no import at all, which a repository's
// page would take for an empty repository.
import { deferred } from './background';
import { directOn } from './repo-import-direct';
import { askedKey, type ImportParams } from './repo-import-head';
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

/** How long a look at the import waits for the Workflow's status before saying what it
 * knows: a page polling every 0.5 s learns of main from this answer. */
const STATUS_WAIT_MS = 300;
/** How long the request's own create may take before a look at the import tries again: past
 * its 30 s behind the answer it has failed. */
const CREATE_WAIT_MS = 30_000;

const workflowId = (repo: string) => `import-${repo}`;

const created = (env: Env, params: ImportParams) =>
  env.PLATFORM_IMPORT.create({ id: workflowId(params.repo), params }).catch((e) => {
    if (!/already.?exists/i.test(String(e?.message))) throw e;
  });

/** Starts the Workflow of `params`, and answers its name: behind the answer when what starts
 * it again is durable, so that a failure here leaves nothing lost. */
export async function startWorkflow(env: Env, params: ImportParams) {
  const kept =
    directOn(env, params.url) &&
    (await env.OBJECTS.put(askedKey(params.repo), JSON.stringify(params)).catch((e) => {
      console.warn(`import not kept: ${params.repo}: ${e?.message ?? e}`);
      return null;
    }));
  const create = async () => {
    const asked = Date.now();
    await created(env, params);
    console.log(JSON.stringify({ event: 'import.workflow_created', ms: Date.now() - asked }));
  };
  if (!kept || !deferred(create)) await create();
  return workflowId(params.repo);
}

/** Whether `repo` is an import whose Workflow may not have started yet. */
async function askedFor(env: Env, repo: string): Promise<ImportParams | null> {
  const noted = await env.OBJECTS.get(askedKey(repo));
  return noted ? noted.json<ImportParams>() : null;
}

/** The Workflow's status. With none, an import still to start is started: this is what mends
 * a request that died first. */
async function workflowStatus(env: Env, repo: string): Promise<Json> {
  try {
    return await (await env.PLATFORM_IMPORT.get(workflowId(repo))).status();
  } catch (e: any) {
    if (!String(e?.message).includes('instance.not_found')) throw e;
    const params = await askedFor(env, repo);
    if (!params) throw new ApiError('NOT_FOUND', 'This repository has no import');
    if (Date.now() - (params.asked_at ?? 0) > CREATE_WAIT_MS)
      await created(env, params).catch((e) => {
        console.warn(`import not started: ${repo}: ${e?.message ?? e}`);
      });
    return { status: 'queued' };
  }
}

/** `GET /repos/<id>/import`: the Workflow's status, and history's progress. */
export async function importProgress(ctx: RepoContext) {
  const { env, repo } = ctx;
  const { history_import } = await ctx.call({ op: 'repo_status' }); // read access first
  const asked = workflowStatus(env, repo);
  asked.catch(() => {});
  const late = new Promise<null>((done) => setTimeout(() => done(null), STATUS_WAIT_MS));
  const status =
    (await Promise.race([asked, late])) ??
    (history_import || (await askedFor(env, repo)) ? { status: 'running' } : await asked);
  // A Workflow that died cannot end its history: a repository must not wait on it.
  const dead = ['errored', 'terminated'].includes(String(status.status));
  if (history_import && dead)
    await caller(env, repo, { _system: 'import' })({
      op: 'repo_record_imported_end',
      reason: 'The import stopped before its history was in.',
    });
  return { import: workflowId(repo), ...status, history: dead ? null : history_import };
}
