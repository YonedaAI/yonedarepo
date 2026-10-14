import { providerDefinition } from '../../shared/providers';
import { username } from './accounts';
import { error, readJson, response } from './http';
import { type MiMoRouting, mimoRouting } from './mimo-routing';
import type { Env, Json, Principal } from './types';
import { providerCredentials, resealModelAlias, seal } from './vault';
import { workspace } from './workspace';

const models = [
  { model: 'mimo-v2.6-flash', connection: 'reviewer-mimo-flash-2-6' },
  { model: 'mimo-v2.6-pro', connection: 'reviewer-mimo-pro-2-6' },
];

/** Add reviewer model choices without reprovisioning access, funding or project policy. */
export async function reviewerManagedMiMo(req: Request, env: Env, principal: Principal) {
  if (principal.role !== 'admin') return error('FORBIDDEN', 'Administrator required', 403);
  if (req.method !== 'POST') return error('NOT_FOUND', 'Unknown reviewer operation', 404);
  const input = await readJson(req);
  if (Object.keys(input).some((key) => !['username', 'routing'].includes(key)))
    return error(
      'INVALID_INPUT',
      'Only the existing reviewer and optional MiMo routing are accepted',
    );
  const owner = username(input.username);
  const reviewer = await workspace(env, owner, { op: 'reviewer_status' });
  if (!reviewer || reviewer.revoked || reviewer.expires <= Date.now())
    return error('FORBIDDEN', 'An active existing reviewer is required', 403);
  const explicitRouting = input.routing !== undefined;
  let requested: MiMoRouting | undefined;
  try {
    requested = mimoRouting('mimo', input.routing);
  } catch {
    return error('INVALID_INPUT', 'Token Plan requires an explicit cn, sgp or ams region');
  }
  const saved: Json[] = (await workspace(env, owner, { op: 'settings' })).providers;
  // Fixed identities are never overwritten, including a different provider or billing route.
  for (const target of models) {
    const existing = saved.find((connection) => connection.id === target.connection);
    if (existing && (existing.provider !== 'mimo' || existing.model !== target.model))
      return error(
        'IDEMPOTENCY_CONFLICT',
        'Managed MiMo identity is already configured differently',
        409,
      );
  }
  const existingMiMo = saved.filter((connection) => connection.provider === 'mimo');
  let source = existingMiMo.find(
    (connection) => !explicitRouting || sameRoute(connection.routing, requested),
  );
  if (!source && existingMiMo.length)
    return error(
      'IDEMPOTENCY_CONFLICT',
      'Existing MiMo billing route differs; no connection was changed',
      409,
    );
  const routing = source ? mimoRouting('mimo', source.routing) : requested;
  for (const target of models) {
    const existing = saved.find((connection) => connection.id === target.connection);
    if (existing && !sameRoute(existing.routing, routing))
      return error(
        'IDEMPOTENCY_CONFLICT',
        'Managed MiMo billing route differs; no connection was changed',
        409,
      );
    if (
      !providerDefinition('mimo').models.find((model) => model.id === target.model)
        ?.conservative_pricing
    )
      return error('PROVIDER_CONFIGURATION', 'MiMo catalog pricing is required', 409);
  }
  if (!source) {
    // Key remains Worker-local. A tp-/ttp- key without explicit routing fails here,
    // before provider_put; its region cannot be inferred or changed to API credits.
    const credentials = await providerCredentials(
      env,
      '_admin',
      'mimo',
      undefined,
      undefined,
      routing,
    );
    source = await workspace(env, owner, {
      op: 'provider_put',
      provider: 'mimo',
      ...models[0],
      label: 'MiMo 2.6 Flash',
      routing: credentials.routing,
      sealed: await seal(env, owner, 'mimo', credentials.key, models[0].connection),
    });
    saved.push(source);
  }
  const choices = [];
  for (const target of models) {
    let connection = saved.find(
      (connection) =>
        connection.provider === 'mimo' &&
        connection.model === target.model &&
        sameRoute(connection.routing, routing),
    );
    if (!connection) {
      const secret = await workspace(env, owner, { op: 'provider_secret', connection: source.id });
      if (secret.version !== source.version)
        return error(
          'STALE_CONNECTION',
          'MiMo source changed; reload before adding its model',
          409,
        );
      connection = await workspace(env, owner, {
        op: 'provider_model_alias',
        provider: 'mimo',
        ...target,
        source_connection: source.id,
        expected_version: source.version,
        label: providerDefinition('mimo').models.find((model) => model.id === target.model)?.label,
        sealed: await resealModelAlias(env, owner, secret, target.connection),
      });
      saved.push(connection);
    }
    choices.push({ connection: connection.id, model: connection.model });
  }
  return response({ models: choices });
}

function sameRoute(left: Json | undefined, right: Json | undefined) {
  return JSON.stringify(mimoRouting('mimo', left)) === JSON.stringify(mimoRouting('mimo', right));
}
