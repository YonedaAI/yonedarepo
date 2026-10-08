import { error, readJson, response } from './http';
import type { Env, Principal } from './types';
import { seal } from './vault';
import { workspace } from './workspace';

const providers = ['codex', 'claude', 'mimo', 'zai', 'gemini'];
export async function settingsRoute(
  req: Request,
  env: Env,
  principal: Principal,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/settings')) return null;
  if (principal.role !== 'user')
    return error('FORBIDDEN', 'Sign in with a personal account for provider settings', 403);
  if (path === '/api/settings' && req.method === 'GET') {
    const result = response(await workspace(env, principal.workspace, { op: 'settings' }));
    result.headers.set('cache-control', 'no-store');
    return result;
  }
  const parts = path.split('/');
  const named = parts[3] === 'connections';
  if (parts.length > 5 || (!named && parts[3] !== 'providers'))
    return error('NOT_FOUND', 'Unknown provider setting', 404);
  const connection = parts[4];
  if (req.method === 'DELETE' && connection && /^[A-Za-z0-9_-]{1,80}$/.test(connection))
    return response(
      await workspace(env, principal.workspace, { op: 'provider_delete', connection }),
    );
  if (req.method !== 'POST' || (named && connection))
    return error('NOT_FOUND', 'Unknown provider setting', 404);
  const body = await readJson(req);
  const provider = named ? body.provider : connection;
  if (!providers.includes(provider)) return error('INVALID_INPUT', 'Unknown provider');
  if (
    typeof body.key !== 'string' ||
    body.key.trim().length < 8 ||
    body.key.length > 4096 ||
    /[\r\n]/.test(body.key)
  )
    return error('INVALID_INPUT', 'Enter a provider API key');
  if (provider === 'claude' && body.model !== 'claude-sonnet-4-6')
    return error('INVALID_INPUT', 'Claude testing uses claude-sonnet-4-6');
  const id = named ? `connection-${crypto.randomUUID()}` : provider;
  const sealed = await seal(
    env,
    principal.workspace,
    provider,
    body.key.trim(),
    named ? id : undefined,
  );
  body.key = '';
  return response(
    await workspace(env, principal.workspace, {
      op: 'provider_put',
      provider,
      model: body.model,
      ...(named ? { connection: id, label: body.label } : {}),
      sealed,
    }),
  );
}
