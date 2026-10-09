import type { Env, Json } from './types';

export async function workspace(env: Env, name: string, command: Json): Promise<Json> {
  const result = await env.WORKSPACES.get(env.WORKSPACES.idFromName(`account:${name}`)).fetch(
    'http://workspace/command',
    { method: 'POST', body: JSON.stringify(command) },
  );
  const value = await result.json<Json>();
  if (!result.ok)
    throw Object.assign(new Error(value.error?.message ?? 'Workspace request failed'), {
      code: value.error?.code ?? 'WORKSPACE_FAILED',
    });
  return value;
}
