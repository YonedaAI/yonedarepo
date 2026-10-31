import type { Env, Json } from './types';

async function authority(env: Env, name: string, command: Json): Promise<Json> {
  const result = await env.WORKSPACES.get(env.WORKSPACES.idFromName(name)).fetch(
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

/** An account's authority. With AUDIT_LOG on, it also records the person's sign-ins. */
export function workspace(env: Env, name: string, command: Json): Promise<Json> {
  const audited = env.AUDIT_LOG === 'on' ? { ...command, audit_log: true } : command;
  return authority(env, `account:${name}`, audited);
}

/** An organization's audit log: an authority instance of its own, beside the org's. */
export function auditLog(env: Env, org: string, command: Json): Promise<Json> {
  return authority(env, `audit:${org}`, command);
}

/** An owner's search directory: an authority instance of its own, beside the owner's. */
export function searchDirectory(env: Env, owner: string, command: Json): Promise<Json> {
  return authority(env, `search:${owner}`, command);
}
