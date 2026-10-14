import { sourceError } from './source-contract';
import type { Env, Json } from './types';

/** Private typed adapter. Browser/model arguments never choose an authority or grant. */
export async function sourceAuthority<T = Json>(
  env: Env,
  workspaceId: string,
  command: Json,
): Promise<T> {
  if (!env.SOURCES) throw sourceError('SOURCE_UNAVAILABLE', 'Source authority is updating');
  if (!/^source-workspace:[a-f0-9]{64}$/.test(workspaceId))
    throw sourceError('SOURCE_SCOPE', 'Invalid server source identity');
  const stub = env.SOURCES.get(env.SOURCES.idFromName(workspaceId));
  const response = await stub.fetch('http://source/command', {
    method: 'POST',
    body: JSON.stringify(command),
  });
  const value = await response.json<Json>();
  if (!response.ok)
    throw sourceError(
      value.error?.code ?? 'SOURCE_FAILED',
      value.error?.message ?? 'Source authority rejected the request',
    );
  return value as T;
}
