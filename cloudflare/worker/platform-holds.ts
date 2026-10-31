// Legal holds over REST: `/orgs/:org/hold` and `/orgs/:org/repos/:repo/hold` for the org's
// owners (any member reads), `/admin/orgs/:org/hold` and `/admin/repos/:repo/hold` for
// operators, `GET /repos/:repo/hold` for a repository's page. The account authority of the
// owner holds them and decides who lifts what (accounts/holds.rs); each change is audited
// there, and an operator's in admin_audit as well. Without the `LEGAL_HOLD` switch none of
// these exist.
//
// A repository's owner comes from its authority, not the listing: a tombstone has left the
// listing, and it is exactly what a hold must still reach before its purge.

import { audit } from './platform-admin-queries';
import { holdsOn } from './platform-legal-hold';
import { ApiError, type Credentials, caller, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

const REPO = /^r[0-9a-f]{20}$/;

function requireHolds(env: Env) {
  if (!holdsOn(env)) throw new ApiError('NOT_FOUND', 'Unknown API path');
}

/** The account that owns `repo`, live or a tombstone. */
async function ownerOf(env: Env, repo: string): Promise<string> {
  if (!REPO.test(repo)) throw new ApiError('NOT_FOUND', 'Unknown repository');
  const { owner } = await caller(env, repo, { _system: 'purge' })({ op: 'repo_hold_owner' });
  return String(owner);
}

/** `GET /repos/:id/hold`: for its members; a public repository's readers are not told. */
export async function repoHold(ctx: RepoContext) {
  requireHolds(ctx.env);
  const { owner } = await ctx.call({ op: 'repo_hold_owner' });
  return workspace(ctx.env, String(owner), { op: 'hold_check', repo: ctx.repo });
}

/** `/orgs/:org/hold` and `/orgs/:org/repos/:repo/hold`, `run` being the org's commands as
 * the calling account. Membership is asked first, so nobody else learns who owns `repo`. A
 * token limited to some repositories changes their holds alone, never the org's: its
 * allowlist is `caller`'s to enforce, and these commands go to the org's authority. */
export async function orgHold(
  env: Env,
  auth: Credentials,
  org: string,
  method: string,
  run: (command: Json) => Promise<Json>,
  repo?: string,
) {
  requireHolds(env);
  if (method === 'GET' && !repo) return run({ op: 'org_hold_show' });
  if (method !== 'POST' && method !== 'DELETE') throw new ApiError('NOT_FOUND', 'Unknown API path');
  const allowed = '_pat' in auth ? auth._pat.repos : null;
  if (allowed !== null && !(repo && allowed.includes(repo)))
    throw new ApiError('FORBIDDEN', 'This token is not allowed on this repository');
  if (repo) {
    await run({ op: 'org_show' });
    if ((await ownerOf(env, repo)) !== org)
      throw new ApiError('NOT_FOUND', 'This organization does not own that repository');
  }
  return run({ op: method === 'POST' ? 'org_hold_set' : 'org_hold_release', repo });
}

/** Sets or lifts the operators' layer: on `owner` as a whole, or on `repo` of it. */
async function operatorHold(env: Env, actor: string, owner: string, method: string, repo?: string) {
  const set = method === 'POST';
  const done = await workspace(env, owner, {
    op: set ? 'hold_operator_set' : 'hold_operator_release',
    operator: actor,
    repo,
  });
  await audit(env, actor, set ? 'legal_hold.set' : 'legal_hold.release', repo ?? owner);
  return done;
}

/** `POST` or `DELETE /admin/orgs/:org/hold`. */
export function operatorOrgHold(env: Env, actor: string, org: string, method: string) {
  requireHolds(env);
  return operatorHold(env, actor, org, method);
}

/** `POST` or `DELETE /admin/repos/:id/hold`: any repository, live or a tombstone. */
export async function operatorRepoHold(env: Env, actor: string, repo: string, method: string) {
  requireHolds(env);
  return operatorHold(env, actor, await ownerOf(env, repo), method, repo);
}
