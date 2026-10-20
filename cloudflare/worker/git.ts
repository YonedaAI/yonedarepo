import type { OutboundHandler } from '@cloudflare/containers';
import { gitRole } from './git-policy';
import { error } from './http';
import { scopeFor } from './scope';
import type { Env } from './types';
export const gitHandler: OutboundHandler<Env> = async (req, env, ctx) => {
  try {
    const { scope } = await scopeFor(env, ctx.containerId);
    const job = scope.job;
    // Agents never hold Git access; only the supervisor's trusted capture and publish do.
    if (req.headers.get('authorization') !== `Bearer ${scope.supervisor}`)
      return error('FORBIDDEN', 'Trusted Git client required', 403);
    const url = new URL(req.url);
    const [_, role, ...tail] = url.pathname.split('/');
    if (job.payload?.workspace_transport === 'api-source-v1') {
      const capability = role ? gitRole(scope, role) : null;
      if (!capability) return error('FORBIDDEN', 'Attempt Git capability unavailable', 403);
      const repository = capability.repository;
      const [namespace, name] = repository?.split('/') ?? [];
      if (!name || namespace !== env.ARTIFACTS_NAMESPACE)
        return error('FORBIDDEN', 'Attempt Git repository unavailable', 403);
      const receive =
        url.pathname.endsWith('/git-receive-pack') ||
        url.searchParams.get('service') === 'git-receive-pack';
      const writable = capability.writable;
      if (receive && !writable) return error('FORBIDDEN', 'Read-only Git capability', 403);
      const endpoint = tail.join('/');
      const service =
        endpoint === 'info/refs' && req.method === 'GET'
          ? url.searchParams.get('service')
          : req.method === 'POST'
            ? endpoint
            : null;
      if (
        !['git-upload-pack', 'git-receive-pack'].includes(service ?? '') ||
        !['info/refs', 'git-upload-pack', 'git-receive-pack'].includes(endpoint)
      )
        return error('FORBIDDEN', 'Git endpoint not allowed', 403);
      return proxyArtifacts(req, env, name, tail.join('/'), url.search, receive);
    }
    if (!['capture', 'publish'].includes(job.kind) || !['canonical', 'candidate'].includes(role))
      return error('FORBIDDEN', 'Git capability unavailable', 403);
    const endpoint = tail.join('/');
    const service =
      endpoint === 'info/refs' && req.method === 'GET'
        ? url.searchParams.get('service')
        : req.method === 'POST'
          ? endpoint
          : null;
    if (
      !['git-upload-pack', 'git-receive-pack'].includes(service ?? '') ||
      !['info/refs', 'git-upload-pack', 'git-receive-pack'].includes(endpoint)
    )
      return error('FORBIDDEN', 'Git endpoint not allowed', 403);
    const revision =
      role === 'canonical'
        ? job.kind === 'capture'
          ? job.payload.base.repository
          : `${job.payload.canonical.namespace}/${job.payload.canonical.name}`
        : (scope.fork ?? job.payload.target.repository);
    const [namespace, name] = revision.split('/');
    if (namespace !== env.ARTIFACTS_NAMESPACE) throw new Error('Wrong namespace');
    const write = role === 'candidate' ? job.kind === 'capture' : job.kind === 'publish';
    const receive =
      tail.join('/') === 'git-receive-pack' ||
      url.searchParams.get('service') === 'git-receive-pack';
    if (receive && !write) return error('FORBIDDEN', 'Read-only Git capability', 403);
    return proxyArtifacts(req, env, name, tail.join('/'), url.search, receive);
  } catch (e: any) {
    // Agents only see git's generic "HTTP 409"; record the actual failing step for operators.
    console.error(
      JSON.stringify({
        event: 'git_proxy.failed',
        path: new URL(req.url).pathname,
        stage: e?.stage ?? 'scope',
        error: String(e?.message ?? e).slice(0, 300),
      }),
    );
    return error('GIT_PROXY', e.message, 409);
  }
};

async function proxyArtifacts(
  req: Request,
  env: Env,
  name: string,
  path: string,
  search: string,
  receive: boolean,
) {
  const staged = async <T>(stage: string, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (e: any) {
      throw Object.assign(new Error(`${stage} ${name}: ${e?.message ?? e}`), { stage });
    }
  };
  using repo = await staged('artifacts.get', () => env.ARTIFACTS.get(name));
  const info = await staged('artifacts.info', () => repo.info());
  const token = await staged('artifacts.token', () =>
    repo.createToken(receive ? 'write' : 'read', 60),
  );
  try {
    const remote = new URL(`${info.remote}/${path}`);
    remote.search = search;
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${token.plaintext}`);
    const result = await fetch(
      new Request(remote, { method: req.method, headers, body: req.body, redirect: 'manual' }),
    );
    if (result.status >= 300 && result.status < 400)
      return error('GIT_PROXY', 'Unexpected upstream redirect', 502);
    return result;
  } finally {
    await repo.revokeToken(token.id);
  }
}
