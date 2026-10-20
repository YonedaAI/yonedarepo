import { repositoryPlatform } from './agents-platform';
import { error, readJson, response } from './http';
import { platformSource } from './source-objects';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';

async function observeCanonical(env: Env, principal: Principal, repo: string) {
  const status = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  const observed = await platformSource(await repositoryPlatform(env, status.id)).head('main');
  if (!observed)
    throw new Error('Canonical remote has no readable HEAD; recovery did not change the ledger');
  return observed;
}

/** The owner supplies CAS expectations; only the platform supplies the observed commit. */
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

/**
 * After the owner selects a checked candidate, the agent layer records its independent
 * checks on the exact platform commit (its token has the check scope; it can never land).
 * Overridden checks are recorded as failing, so only the owner's break-glass lands them.
 */
export async function recordPublicationChecks(env: Env, repo: string, receipt: Json) {
  const landing = receipt?.publication;
  if (!landing?.commit) return;
  const platform = await repositoryPlatform(env, repo);
  await platform.call('POST', `/commits/${landing.commit}/checks`, {
    name: 'yoneda-checks',
    status: landing.break_glass ? 'fail' : 'pass',
    evidence: `YonedaRepo decision ${receipt.id}`,
  });
}

/** The owner landed (or tried to) on the platform; only the platform's `main` completes it. */
export async function publicationReadback(
  req: Request,
  env: Env,
  principal: Principal,
  repo: string,
) {
  const input = await readJson(req);
  if (!boundedId(input?.decision_id, 256)) return error('INVALID_INPUT', 'decision_id is required');
  const status = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  const platform = await repositoryPlatform(env, status.id);
  const observed = await platformSource(platform).head('main');
  if (!observed) throw new Error('The platform repository has no main branch');
  const landed = await platform.call('GET', `/commits/${observed}`);
  const version = landed.landings?.find((l: Json) => l.refname === 'refs/heads/main')?.version;
  return response(
    await ledger(env, repo, {
      op: 'publication_readback',
      decision_id: input.decision_id,
      observed_commit: observed,
      land_version: version ?? null,
    }),
  );
}
