import { grantPrincipal } from './grants';
import { error, safeId } from './http';
import { ledger } from './storage';
import type { Env } from './types';
export async function externalGit(req: Request, env: Env, parts: string[]): Promise<Response> {
  const repo = parts[1];
  const attempt = parts[2];
  if (!safeId(repo)) return error('NOT_FOUND', 'Unknown repository', 404);
  const principal = await grantPrincipal(req, env);
  if (!principal) return error('UNAUTHORIZED', 'Repository agent key required', 401);
  if (principal.grant?.repo !== repo)
    return error('FORBIDDEN', 'Key belongs to another repository', 403);
  if (req.headers.has('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return error('FORBIDDEN', 'Unexpected Git origin', 403);
  const path = parts.slice(3).join('/');
  const url = new URL(req.url);
  const service =
    path === 'info/refs' && req.method === 'GET'
      ? url.searchParams.get('service')
      : req.method === 'POST'
        ? path
        : null;
  if (
    !['git-upload-pack', 'git-receive-pack'].includes(service ?? '') ||
    !['info/refs', 'git-upload-pack', 'git-receive-pack'].includes(path)
  )
    return error('FORBIDDEN', 'Git endpoint not allowed', 403);
  const receive = service === 'git-receive-pack';
  if (receive && (attempt === 'source' || principal.grant.scope !== 'contribute'))
    return error('FORBIDDEN', 'Canonical writes are unavailable', 403);
  try {
    let name: string;
    if (attempt === 'source') {
      const s = await ledger(env, repo, { op: 'snapshot', _workspace: principal.workspace });
      name = s.repository.remote.name;
    } else {
      if (!/^external-[a-f0-9]{32}$/.test(attempt))
        return error('FORBIDDEN', 'Unknown contribution', 403);
      const job = await ledger(env, repo, {
        op: 'external_check',
        attempt_id: attempt,
        _workspace: principal.workspace,
        _grant: principal.grant.id,
      });
      name = job.external_fork.split('/')[1];
    }
    using remote = await env.ARTIFACTS.get(name);
    const info = await remote.info();
    const token = await remote.createToken(receive ? 'write' : 'read', 60);
    try {
      const upstream = new URL(`${info.remote}/${path}`);
      upstream.search = url.search;
      const headers = new Headers();
      for (const name of [
        'content-type',
        'content-encoding',
        'git-protocol',
        'accept',
        'user-agent',
      ]) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set('authorization', `Bearer ${token.plaintext}`);
      const response = await fetch(
        new Request(upstream, { method: req.method, headers, body: req.body, redirect: 'manual' }),
      );
      if (response.status >= 300 && response.status < 400)
        return error('GIT_PROXY', 'Unexpected upstream redirect', 502);
      const safeHeaders = new Headers(response.headers);
      for (const name of ['set-cookie', 'location', 'access-control-allow-credentials'])
        safeHeaders.delete(name);
      safeHeaders.set('cache-control', 'no-store');
      return new Response(response.body, { status: response.status, headers: safeHeaders });
    } finally {
      await remote.revokeToken(token.id);
    }
  } catch (e) {
    return error('FORBIDDEN', (e as Error).message, 403);
  }
}
