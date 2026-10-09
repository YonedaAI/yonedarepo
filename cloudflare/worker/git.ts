import type { OutboundHandler } from '@cloudflare/containers';
import { error } from './http';
import { scopeFor } from './scope';
import type { Env } from './types';
export const gitHandler: OutboundHandler<Env> = async (req, env, ctx) => {
  try {
    const { scope } = await scopeFor(env, ctx.containerId);
    const job = scope.job;
    if (req.headers.get('authorization') !== `Bearer ${scope.supervisor}`)
      return error('FORBIDDEN', 'Trusted Git client required', 403);
    const url = new URL(req.url);
    const [_, role, ...tail] = url.pathname.split('/');
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
    using repo = await env.ARTIFACTS.get(name);
    const info = await repo.info();
    const token = await repo.createToken(receive ? 'write' : 'read', 60);
    const remote = new URL(`${info.remote}/${tail.join('/')}`);
    remote.search = url.search;
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${token.plaintext}`);
    const result = await fetch(
      new Request(remote, { method: req.method, headers, body: req.body, redirect: 'manual' }),
    );
    // Revocation after fetch headers is safe: the Artifacts request has authenticated already.
    await repo.revokeToken(token.id);
    return result;
  } catch (e: any) {
    return error('GIT_PROXY', e.message, 409);
  }
};
