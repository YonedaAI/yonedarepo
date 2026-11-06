// Credential resolution for platform requests. Authentication belongs to each request.
import { authenticate } from './auth';
import { noteAccount } from './internal-accounts';
import { orgAccess } from './platform-org-access';
import type { Credentials } from './repo-ops';
import { refuseOutsideKeys, verifyPat } from './repo-pat';
import type { Env } from './types';

/** The caller of a platform request: a repository token, a personal access token (checked
 * with its account on every request), or a workspace session; null when none is valid. */
export async function credentials(
  req: Request,
  env: Env,
  onUser?: () => void,
): Promise<Credentials | null> {
  const auth = await checkCredentials(req, env, onUser);
  noteAccount(auth);
  return auth;
}

async function checkCredentials(
  req: Request,
  env: Env,
  onUser?: () => void,
): Promise<Credentials | null> {
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer yrp_')) return { _token: bearer.slice(7) };
  if (bearer?.startsWith('Bearer ypat_')) {
    const grant = await verifyPat(env, bearer.slice(7));
    if (grant) refuseOutsideKeys(grant, new URL(req.url).pathname);
    return grant && { _pat: grant };
  }
  const principal = await authenticate(req, env);
  if (!principal) return null;
  const name = principal.role === 'admin' ? 'admin' : `user:${principal.workspace}`;
  // Only a personal account session is a person; admin bearers may be held by scripts.
  const human = principal.role === 'user' ? { human: true as const } : {};
  // Only non-authorizing request-local reads may start before organization admission.
  if (principal.role === 'user') onUser?.();
  const orgs = await orgAccess(env, principal.workspace, principal.orgs ?? []);
  return {
    _session: { workspace: principal.workspace, principal: name, ...human, ...(orgs && { orgs }) },
  };
}
