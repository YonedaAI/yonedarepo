// Credential resolution for platform requests. In-flight session checks are shared only until answered.
import { authenticate } from './auth';
import { noteAccount } from './internal-accounts';
import { orgAccess } from './platform-org-access';
import type { Credentials } from './repo-ops';
import { refuseOutsideKeys, verifyPat } from './repo-pat';
import type { Env } from './types';

/** Session checks in flight in this isolate, by everything `authenticate` reads: requests
 * with identical credentials arriving together share one check (no result outlives it). */
const checking = new Map<string, ReturnType<typeof authenticate>>();
function authenticateOnce(req: Request, env: Env) {
  const key = JSON.stringify(
    ['origin', 'authorization', 'cookie', 'cf-access-jwt-assertion'].map((h) => req.headers.get(h)),
  ).concat(new URL(req.url).origin);
  let check = checking.get(key);
  if (!check) {
    check = authenticate(req, env).finally(() => checking.delete(key));
    checking.set(key, check);
  }
  return check;
}

/** The caller of a platform request: a repository token, a personal access token (checked
 * with its account on every request), or a workspace session; null when none is valid. */
export async function credentials(req: Request, env: Env): Promise<Credentials | null> {
  const auth = await checkCredentials(req, env);
  noteAccount(auth);
  return auth;
}

async function checkCredentials(req: Request, env: Env): Promise<Credentials | null> {
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer yrp_')) return { _token: bearer.slice(7) };
  if (bearer?.startsWith('Bearer ypat_')) {
    const grant = await verifyPat(env, bearer.slice(7));
    if (grant) refuseOutsideKeys(grant, new URL(req.url).pathname);
    return grant && { _pat: grant };
  }
  const principal = await authenticateOnce(req, env);
  if (!principal) return null;
  const name = principal.role === 'admin' ? 'admin' : `user:${principal.workspace}`;
  // Only a personal account session is a person; admin bearers may be held by scripts.
  const human = principal.role === 'user' ? { human: true as const } : {};
  const orgs = await orgAccess(env, principal.workspace, principal.orgs ?? []);
  return {
    _session: { workspace: principal.workspace, principal: name, ...human, ...(orgs && { orgs }) },
  };
}
