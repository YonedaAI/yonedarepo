import { providers } from '../../shared/providers';
import { error, readJson, response } from './http';
import { type MiMoRouting, mimoRouting, validateMiMoKey } from './mimo-routing';
import type { Env, Principal } from './types';
import { open, seal } from './vault';
import { workspace } from './workspace';

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
  if (req.method !== 'POST') return error('NOT_FOUND', 'Unknown provider setting', 404);
  const body = await readJson(req);
  if (named && connection) {
    const old = await workspace(env, principal.workspace, { op: 'provider_secret', connection });
    const routing = mimoRouting(old.provider, body.routing ?? old.routing);
    const key =
      body.key == null || body.key === ''
        ? await open(env, principal.workspace, old.provider, old.sealed, connection)
        : typeof body.key === 'string'
          ? body.key.trim()
          : body.key;
    if (typeof key !== 'string' || key.length < 8 || key.length > 4096 || /[\r\n]/.test(key))
      return error('INVALID_INPUT', 'Enter a provider API key');
    validateMiMoKey(old.provider, key, routing);
    return response(
      await workspace(env, principal.workspace, {
        op: 'provider_update',
        connection,
        expected_version: body.expected_version,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(routing ? { routing } : {}),
        ...(body.key
          ? { sealed: await seal(env, principal.workspace, old.provider, key, connection) }
          : {}),
      }),
    );
  }
  const provider = named ? body.provider : connection;
  if (!providers.some((entry) => entry.id === provider))
    return error('INVALID_INPUT', 'Unknown provider');
  if (
    typeof body.key !== 'string' ||
    body.key.trim().length < 8 ||
    body.key.length > 4096 ||
    /[\r\n]/.test(body.key)
  )
    return error('INVALID_INPUT', 'Enter a provider API key');
  if (
    provider === 'claude' &&
    !providers
      .find((entry) => entry.id === provider)
      ?.models.some((model) => model.id === body.model)
  )
    return error('INVALID_INPUT', 'Choose a supported Claude model');
  let routing: MiMoRouting | undefined;
  try {
    routing = mimoRouting(provider, body.routing);
    validateMiMoKey(provider, body.key.trim(), routing);
  } catch (failure) {
    return error('INVALID_INPUT', (failure as Error).message);
  }
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
      ...(routing ? { routing } : {}),
      ...(named ? { connection: id, label: body.label } : {}),
      sealed,
    }),
  );
}
