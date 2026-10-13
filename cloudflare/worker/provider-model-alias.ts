import { providerDefinition } from '../../shared/providers';
import { error, readJson, response } from './http';
import { sha } from './storage';
import type { Env, Principal } from './types';
import { resealModelAlias } from './vault';
import { workspace } from './workspace';

/** Alias the owner's existing key into a create-only, priced model binding. */
export async function providerModelAlias(
  req: Request,
  env: Env,
  principal: Principal,
  sourceId: string,
) {
  const input = await readJson(req);
  if (Object.keys(input).some((key) => !['model', 'expected_version', 'label'].includes(key)))
    return error('INVALID_INPUT', 'Only model, source version and optional label are accepted');
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0)
    return error('INVALID_INPUT', 'An exact source connection version is required');
  const source = await workspace(env, principal.workspace, {
    op: 'provider_secret',
    connection: sourceId,
  });
  if ((source.version ?? 0) !== input.expected_version)
    return error('STALE_CONNECTION', 'Source connection changed; reload its settings', 409);
  const model = providerDefinition(source.provider).models.find(
    (model) => model.id === input.model,
  );
  if (!model?.conservative_pricing)
    return error('INVALID_INPUT', 'Choose a supported model with verified catalog pricing');
  const label = input.label ?? model.label;
  if (
    typeof label !== 'string' ||
    !label.trim() ||
    label.length > 80 ||
    [...label].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return error('INVALID_INPUT', 'Enter a connection label of at most 80 characters');
  const id = `alias-${(await sha(JSON.stringify([principal.workspace, sourceId, input.expected_version, source.provider, model.id]))).slice(0, 40)}`;
  const sealed = await resealModelAlias(env, principal.workspace, source, id);
  const result = response(
    await workspace(env, principal.workspace, {
      op: 'provider_model_alias',
      connection: id,
      source_connection: sourceId,
      expected_version: input.expected_version,
      provider: source.provider,
      model: model.id,
      label,
      sealed,
    }),
  );
  result.headers.set('cache-control', 'no-store');
  return result;
}
