import type { OutboundHandler } from '@cloudflare/containers';
import { error } from './http';
import { scopeFor } from './scope';
import { ledger } from './storage';
import type { Env, Json } from './types';
export const registries = ['registry.npmjs.org', 'index.crates.io', 'static.crates.io'];
export function dependencyRequest(req: Request, job: Json) {
  const url = new URL(req.url);
  if (
    !['agent', 'evaluate'].includes(job.kind) ||
    url.protocol !== 'https:' ||
    !registries.includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !['GET', 'HEAD'].includes(req.method)
  )
    throw new Error('Only read-only npm and crates.io registry downloads are allowed');
  const headers = new Headers();
  for (const name of ['accept', 'user-agent']) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('accept-encoding', 'identity');
  return new Request(url, { method: req.method, headers, redirect: 'manual' });
}
export const dependencyHandler: OutboundHandler<Env> = async (req, env, ctx) => {
  try {
    const { scope } = await scopeFor(env, ctx.containerId);
    const request = dependencyRequest(req, scope.job);
    // Reserve a bounded object before the upstream request. Failed/unknown transfers
    // remain charged so retries and dropped acknowledgments cannot exceed the ceiling.
    await ledger(env, scope.repo_id, {
      op: 'reserve_request',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      kind: 'dependency',
      bytes: 0,
    });
    const result = await fetch(request);
    if (result.status >= 300 && result.status < 400)
      throw new Error('Registry redirects are unavailable');
    const length = Number(result.headers.get('content-length'));
    const bytes =
      result.headers.has('content-length') && Number.isSafeInteger(length) && length >= 0
        ? length
        : 16 * 1024 * 1024;
    await ledger(env, scope.repo_id, {
      op: 'reserve_request',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      kind: 'dependency',
      bytes,
    });
    if (!result.body) return result;
    let total = 0;
    const stream = result.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.length;
          if (total > bytes) throw new Error('Dependency exceeded reserved size');
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(stream, result);
  } catch (e: any) {
    return error(e.code ?? 'DEPENDENCY_PROXY', e.message, 409);
  }
};
