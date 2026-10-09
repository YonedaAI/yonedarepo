import { decodeAccountIdentifier, encodeAccountIdentifier } from '../../shared/account';
import { randomToken } from './accounts';
import { error, readJson, response, safeId } from './http';
import { ledger, sha } from './storage';
import type { Env, Principal } from './types';
import { workspace } from './workspace';
export async function grantPrincipal(req: Request, env: Env): Promise<Principal | null> {
  const raw = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!raw?.startsWith('yoneda.')) return null;
  const parts = raw.split('.');
  if (parts.length !== 4 || !safeId(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return null;
  const owner = decodeAccountIdentifier(parts[1]);
  if (!owner) return null;
  try {
    const grant = await workspace(env, owner, {
      op: 'grant_check',
      id: parts[2],
      token_hash: await sha(parts[3]),
    });
    return {
      workspace: owner,
      role: 'agent',
      grant: { id: grant.id, repo: grant.repo, scope: grant.scope, expires: grant.expires },
    };
  } catch {
    return null;
  }
}
export async function grantRoute(req: Request, env: Env, principal: Principal, repo: string) {
  if (principal.role !== 'user')
    return error('FORBIDDEN', 'Sign in with a personal account to manage agent keys', 403);
  await ledger(env, repo, { op: 'snapshot', _workspace: principal.workspace });
  if (req.method === 'GET')
    return response(await workspace(env, principal.workspace, { op: 'grants', repo }));
  const body = await readJson(req);
  if (req.method === 'POST' && body.revoke) {
    const grants = await workspace(env, principal.workspace, { op: 'grants', repo });
    if (!grants.grants.some((g: { id: string }) => g.id === body.revoke))
      return error('NOT_FOUND', 'Agent key not found', 404);
    return response(
      await workspace(env, principal.workspace, { op: 'grant_revoke', id: body.revoke }),
    );
  }
  if (req.method !== 'POST') return error('NOT_FOUND', 'Unknown agent key operation', 404);
  const days = body.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 31)
    return error('INVALID_INPUT', 'Choose 1–31 days');
  const id = `grant-${crypto.randomUUID()}`;
  const secret = randomToken();
  const grant = await workspace(env, principal.workspace, {
    op: 'grant_issue',
    id,
    repo,
    label: body.label,
    scope: body.scope,
    expires: Date.now() + days * 86400000,
    token_hash: await sha(secret),
  });
  return response({
    ...grant,
    token: `yoneda.${encodeAccountIdentifier(principal.workspace)}.${id}.${secret}`,
    mcp_url: `${new URL(req.url).origin}/mcp/${repo}`,
  });
}
