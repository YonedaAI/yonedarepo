// An import's Workflow, and what `GET /repos/<id>/import` says of it. A Workflow takes seconds to
// start, so the request does not wait for one: what starts it is kept in R2 first, it is created
// behind the answer, and a look at the import starts it again if that failed. A second create
// finds the first. Until it exists the import reads as `queued`, never as no import at all, which
// a repository's page would take for an empty repository. Main lands last, so the page reads
// `running` until the whole repository is there.

import { deferred } from './background';
import { log } from './log';
import type { CloneParams } from './repo-clone';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

/** How long a look at the import waits for the Workflow's status before saying what it
 * knows. Under what that read really takes (over 400 ms on dev), a finished import reads as
 * running for good and its page never ends. */
const STATUS_WAIT_MS = 3_000;
/** How long the request's own create may take before a look at the import tries again: past
 * its 30 s behind the answer it has failed. */
const CREATE_WAIT_MS = 30_000;

const workflowId = (repo: string) => `import-${repo}`;
/** What starts the import's Workflow, until it has run. */
const askedKey = (repo: string) => `platform/v1/${repo}/import-asked.json`;

/** What an import was asked for. `workflow`: its instance, when a re-import made it a new one
 * (an instance id is used once). */
type Asked = CloneParams & { workflow?: string };

const created = (env: Env, id: string, params: CloneParams) =>
  env.PLATFORM_IMPORT.create({ id, params }).catch((e) => {
    if (!/already.?exists/i.test(String(e?.message))) throw e;
  });

/** Starts the Workflow of `params`, and answers its name: behind the answer when what starts
 * it again is durable, so that a failure here leaves nothing lost. */
export async function startWorkflow(env: Env, params: CloneParams, id = workflowId(params.repo)) {
  const asked: Asked = { ...params, workflow: id };
  const kept = await env.OBJECTS.put(askedKey(params.repo), JSON.stringify(asked)).catch((e) => {
    log.warn('import.not_kept', { repo: params.repo, error: e });
    return null;
  });
  const create = async () => {
    const started = Date.now();
    await created(env, id, params);
    log.info('import.workflow_created', { ms: Date.now() - started });
  };
  if (!kept || !deferred(create)) await create();
  return id;
}

/** What `repo` last imported from, kept for as long as the repository. */
export async function askedFor(env: Env, repo: string): Promise<Asked | null> {
  const noted = await env.OBJECTS.get(askedKey(repo));
  return noted ? noted.json<Asked>() : null;
}

/** Whether `repo`'s last import has yet to end. */
export async function importRunning(env: Env, repo: string, asked: Asked | null) {
  const id = asked?.workflow ?? workflowId(repo);
  const seen = await env.PLATFORM_IMPORT.get(id)
    .then((instance) => instance.status())
    .catch(() => null);
  return ['queued', 'running', 'waiting', 'waitingForPause', 'paused'].includes(seen?.status ?? '');
}

/** The Workflow's status. With none, an import still to start is started: this is what mends
 * a request that died first. */
async function workflowStatus(env: Env, repo: string, asked: Asked | null): Promise<Json> {
  try {
    const id = asked?.workflow ?? workflowId(repo);
    return await (await env.PLATFORM_IMPORT.get(id)).status();
  } catch (e: any) {
    if (!String(e?.message).includes('instance.not_found')) throw e;
    if (!asked) throw new ApiError('NOT_FOUND', 'This repository has no import');
    const { workflow = workflowId(repo), ...params } = asked;
    if (Date.now() - (params.asked_at ?? 0) > CREATE_WAIT_MS)
      await created(env, workflow, params).catch((e) => {
        log.warn('import.not_started', { repo, error: e });
      });
    return { status: 'queued' };
  }
}

/** `GET /repos/<id>/import`: the Workflow's status. */
export async function importProgress(ctx: RepoContext) {
  const { env, repo } = ctx;
  await ctx.call({ op: 'repo_status' }); // read access first
  const asked = await askedFor(env, repo);
  const seen = workflowStatus(env, repo, asked);
  seen.catch(() => {}); // Raced below; losing that race must not leave it unhandled.
  const late = new Promise<null>((done) => setTimeout(() => done(null), STATUS_WAIT_MS));
  const status = (await Promise.race([seen, late])) ?? (asked ? { status: 'running' } : await seen);
  return { import: asked?.workflow ?? workflowId(repo), ...status };
}
