import { readJson, response } from './http';
import { ledger } from './storage';
import type { Env, Principal } from './types';

/** The owner supplies CAS expectations; only Artifacts supplies the observed commit. */
export async function resynchronize(req: Request, env: Env, principal: Principal, repo: string) {
  const input = await readJson(req);
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
