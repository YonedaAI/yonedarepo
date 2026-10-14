import { error, readJson, response } from './http';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';

async function observeCanonical(env: Env, principal: Principal, repo: string) {
  const status = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  using remote = await env.ARTIFACTS.get(status.remote.name);
  const info = await remote.info();
  const observed = (
    await remote.log({ ref: status.remote.branch ?? info.defaultBranch, limit: 1 })
  )[0]?.hash;
  if (!observed)
    throw new Error('Canonical remote has no readable HEAD; recovery did not change the ledger');
  return observed;
}

/** The owner supplies CAS expectations; only Artifacts supplies the observed commit. */
export async function resynchronize(req: Request, env: Env, principal: Principal, repo: string) {
  const input = await readJson(req);
  const observed = await observeCanonical(env, principal, repo);
  return response(
    await ledger(env, repo, {
      op: 'resync_repository',
      _workspace: principal.workspace,
      observed_commit: observed,
      expected_version: input.expected_version,
      expected_pending: input.expected_pending,
    }),
  );
}

const boundedId = (value: unknown, limit: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

/** Validated owner input for retrying a falsely conflicted publication; extra fields are dropped. */
export function publicationRecoveryInput(input: Json) {
  if (
    !boundedId(input?.request_id, 128) ||
    !boundedId(input?.decision_id, 256) ||
    !Number.isSafeInteger(input?.expected_version) ||
    input.expected_version < 0
  )
    return null;
  return {
    request_id: input.request_id as string,
    decision_id: input.decision_id as string,
    expected_version: input.expected_version as number,
  };
}

/**
 * Retry a publication whose publisher reported a conflict. The ledger refuses unless the
 * freshly observed canonical HEAD still equals the head recorded when the decision was made.
 */
export async function recoverPublication(
  req: Request,
  env: Env,
  principal: Principal,
  repo: string,
) {
  const input = publicationRecoveryInput(await readJson(req));
  if (!input)
    return error(
      'INVALID_INPUT',
      'request_id, decision_id and a non-negative expected_version are required',
    );
  const observed = await observeCanonical(env, principal, repo);
  return response(
    await ledger(env, repo, {
      ...input,
      op: 'recover_publication',
      _workspace: principal.workspace,
      observed_commit: observed,
    }),
  );
}
