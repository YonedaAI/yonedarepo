import type { OutboundHandler } from '@cloudflare/containers';
import { error, readJson, response } from './http';
import { scopeFor } from './scope';
import { sourceAuthority } from './source-authority';
import { sourceCapture } from './source-capture';
import { type SourceMount, type SourceRead, sourceError } from './source-contract';
import { publicSourceValue, sourceArguments } from './source-operations';
import { sourceRefresh } from './source-refresh';
import { sourceScope } from './source-scope';
import { registerSourceSeal } from './source-seal';
import { sourceReadResponse } from './source-storage';
import { sourceUpload } from './source-upload';
import type { Env, Json } from './types';

const uploadFields = [
  'request_id',
  'path',
  'sha256',
  'size',
  'mode',
  'expected_workspace_version',
  'expected_file_version',
];
export const sourceBroker: OutboundHandler<Env> = async (req, env, ctx) => {
  try {
    const url = new URL(req.url);
    const refresh = /^\/v1\/refresh\/(context|tree|blob|verify|verify_input|paths)$/.exec(
      url.pathname,
    );
    if (refresh) {
      const { scope } = await scopeFor(env, ctx.containerId);
      if (
        req.headers.get('authorization') !== `Bearer ${scope.supervisor}` ||
        req.method !== 'POST' ||
        url.search
      )
        return error('FORBIDDEN', 'Trusted current refresh supervisor required', 403);
      return await sourceRefresh(env, scope, refresh[1], await readJson(req, 32 * 1024));
    }
    const capture = /^\/v1\/capture\/(context|manifest|tree|blob|verify)$/.exec(url.pathname);
    if (capture) {
      const { scope } = await scopeFor(env, ctx.containerId);
      if (
        req.headers.get('authorization') !== `Bearer ${scope.supervisor}` ||
        req.method !== 'POST' ||
        url.search
      )
        return error('FORBIDDEN', 'Trusted current capture supervisor required', 403);
      return await sourceCapture(env, scope, capture[1], await readJson(req, 32 * 1024));
    }
    const match = /^\/v1\/(repo|candidate-0|candidate-1)\/([a-z_]+)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (!match) return error('FORBIDDEN', 'Unknown source endpoint', 403);
    const mount = match[1] as SourceMount;
    const op = match[2];
    const { scope, stub } = await scopeFor(env, ctx.containerId);
    const supervisor = req.headers.get('authorization') === `Bearer ${scope.supervisor}`;
    const fuseHeader = req.headers.get('x-yoneda-source-fuse');
    if (fuseHeader !== null && (fuseHeader !== '1' || !supervisor))
      return error(
        'FORBIDDEN',
        'Source filesystem marker requires the current root supervisor',
        403,
      );
    const rootFuse = fuseHeader === '1' && supervisor;
    const invalidate = async (paths: string[]) => {
      if (!rootFuse)
        await stub.invalidateSource({
          alias: mount,
          paths,
          job_id: String(scope.job.id),
          epoch: Number(scope.job.epoch),
        });
    };
    if (op === 'blob') {
      if (req.method !== 'PUT' || !req.body)
        return error('INVALID_INPUT', 'Raw source upload required');
      const args: Json = {};
      for (const [key, value] of url.searchParams) {
        if (!uploadFields.includes(key) || key in args)
          throw sourceError('FORBIDDEN', 'Unknown upload selector');
        args[key] = ['size', 'expected_workspace_version', 'expected_file_version'].includes(key)
          ? Number(value)
          : value;
      }
      if (match[3]) {
        if (args.request_id !== undefined)
          throw sourceError('INVALID_INPUT', 'Upload request identity is ambiguous');
        args.request_id = decodeURIComponent(match[3]);
      }
      const context = await sourceScope(env, scope, mount);
      const trusted = await sourceScope(env, scope, mount, true);
      const uploaded = await sourceUpload(env, context, trusted, args, req.body);
      return response(uploaded);
    }
    if (match[3] || url.search || req.method !== 'POST')
      return error('FORBIDDEN', 'Source RPC requires its closed POST envelope', 403);
    const body = await readJson(req, 32 * 1024);
    const command = sourceArguments(op, body, supervisor);
    const context = await sourceScope(env, scope, mount, op === 'source_seal');
    const value = await sourceAuthority<Json>(env, context.binding.workspace_id, {
      ...command,
      _actor: context.actor,
    });
    if (value.file_versions) await invalidate(Object.keys(value.file_versions));
    if (op === 'source_read') return sourceReadResponse(env, context.binding, value as SourceRead);
    if (op === 'source_seal') {
      await registerSourceSeal(env, scope, context, value);
    }
    return response(publicSourceValue(value));
  } catch (failure) {
    const known = failure as { code?: string; message: string };
    return error(
      known.code ?? 'SOURCE_FAILED',
      known.message,
      known.code === 'FORBIDDEN'
        ? 403
        : known.code === 'NOT_FOUND' && new URL(req.url).pathname.startsWith('/v1/refresh/')
          ? 404
          : 409,
    );
  }
};
