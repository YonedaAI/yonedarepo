// Ownership admission and initial tokens shared by repository creation and import.
import { orgArg, orgCaller, orgCommand } from './platform-orgs';
import { toBase64 } from './repo-objects';
import { ApiError, type Credentials, type Json, type RepoContext } from './repo-ops';
import { requirePatScope } from './repo-pat';
import type { Env } from './types';

/**
 * Who owns a new repository: the signed-in workspace, its personal token with repo:admin
 * (acting as the account, never as a person), an organization (`owner`) one of whose
 * owners asks, or, for the operator (admin bearer) provisioning on someone's behalf, the
 * named `workspace`. Never a repository token. Only org owners create an org's
 * repositories (asked of the org's authority at once, never from a cached answer); members
 * get access through teams or membership afterwards.
 */
export async function owning(
  env: Env,
  auth: Credentials,
  body: Json,
): Promise<Credentials & { _session: Json }> {
  if (body.owner !== undefined && body.owner !== null) {
    if (body.workspace !== undefined)
      throw new ApiError('INVALID_INPUT', 'Name an owner or a workspace, not both');
    const org = orgArg(body.owner);
    if ('_pat' in auth) requirePatScope(auth, 'repo:admin');
    const { account } = orgCaller(auth, true, org);
    const access = await orgCommand(env, org, { op: 'org_access', account });
    if (access.role !== 'owner')
      throw new ApiError('FORBIDDEN', `Only an owner of ${org} creates its repositories`);
    return { _session: { workspace: org, principal: `user:${account}` } };
  }
  if ('_pat' in auth && auth._pat.org)
    throw new ApiError(
      'FORBIDDEN',
      `This token is limited to the ${auth._pat.org} organization; name it as the owner`,
    );
  if ('_pat' in auth) {
    requirePatScope(auth, 'repo:admin');
    if (body.workspace !== undefined)
      throw new ApiError(
        'FORBIDDEN',
        'Only the operator creates repositories for another workspace',
      );
    return { _session: { workspace: auth._pat.workspace, principal: auth._pat.principal } };
  }
  if ('_anonymous' in auth) throw new ApiError('UNAUTHORIZED', 'Sign in to create repositories');
  if (!('_session' in auth))
    throw new ApiError('FORBIDDEN', 'Repositories are created by workspace owners');
  if (body.workspace === undefined) return auth;
  if (auth._session.principal !== 'admin')
    throw new ApiError('FORBIDDEN', 'Only the operator creates repositories for another workspace');
  if (typeof body.workspace !== 'string' || !/^[a-z0-9._+@-]{1,254}$/.test(body.workspace))
    throw new ApiError('INVALID_INPUT', 'workspace must be an account identifier');
  return { _session: { workspace: body.workspace, principal: 'admin' } };
}

/** Repository tokens issued with the repository, by its owner, in the same request. */
export async function issueTokens(ctx: RepoContext, requested: unknown) {
  if (requested === undefined) return {};
  if (!Array.isArray(requested) || requested.length > 4)
    throw new ApiError('INVALID_INPUT', 'tokens must be a list of at most 4 {name, scopes}');
  const tokens: Json[] = [];
  for (const spec of requested as Json[]) {
    const secret = tokenSecret();
    const created = await ctx.call({
      op: 'repo_token_create',
      name: spec?.name,
      scopes: spec?.scopes,
      paths: spec?.paths ?? null,
      _secret: secret,
    });
    tokens.push({ ...created, token: secret });
  }
  return { tokens };
}

export function tokenSecret() {
  const raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return `yrp_${raw.replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '')}`;
}
