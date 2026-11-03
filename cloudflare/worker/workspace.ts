import { timed } from './repo-timing';
import { carriedHeaders } from './request-scope';
import type { Env, Json } from './types';

async function authority(env: Env, name: string, command: Json): Promise<Json> {
  const result = await env.WORKSPACES.get(env.WORKSPACES.idFromName(name)).fetch(
    'http://workspace/command',
    { method: 'POST', body: JSON.stringify(command), headers: carriedHeaders() },
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
  // Fixed operation labels separate admission and name lookups without recording identities.
  const phase = ['session', 'org_access', 'handle_lookup', 'owned_repo_resolve'].includes(
    command.op,
  )
    ? `account.${command.op}`
    : 'account.authority';
  return timed(phase, () => authority(env, `account:${name}`, audited));
}

/** An organization's audit log: an authority instance of its own, beside the org's. */
export function auditLog(env: Env, org: string, command: Json): Promise<Json> {
  return authority(env, `audit:${org}`, command);
}

/** An owner's search directory: an authority instance of its own, beside the owner's. */
export function searchDirectory(env: Env, owner: string, command: Json): Promise<Json> {
  return authority(env, `search:${owner}`, command);
}
