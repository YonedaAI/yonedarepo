import { safeId } from './http';
import type { Env, Json } from './types';
export async function sha(content: string) {
  return [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function object(env: Pick<Env, 'OBJECTS'>, content: string, limit = 8 * 1024 * 1024) {
  if (new TextEncoder().encode(content).length > limit)
    throw new Error('Object exceeds size limit');
  const digest = await sha(content);
  await env.OBJECTS.put(`sha256/${digest}`, content, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  return { digest };
}
export async function readObject(env: Pick<Env, 'OBJECTS'>, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid object digest');
  const value = await env.OBJECTS.get(`sha256/${digest}`);
  if (!value) throw new Error('Evidence object is missing');
  const content = await value.text();
  if ((await sha(content)) !== digest) throw new Error('Evidence digest mismatch');
  return content;
}
export async function ledger(env: Env, repo: string, command: Json): Promise<Json> {
  if (!safeId(repo)) throw new Error('Invalid repository ID');
  if (command._workspace && !['init', 'delete_repository'].includes(command.op)) {
    // Old DO binaries ignore unknown scope fields. Prove code adoption and compare
    // immutable ownership before sending any scoped read or mutation across versions.
    const status = await ledger(env, repo, { op: 'repository_status' });
    if (status.capabilities?.workspace_authority !== 1)
      throw Object.assign(new Error('Repository ledger code is still updating; retry shortly'), {
        code: 'LEDGER_UPDATING',
      });
    if ((status.workspace ?? '_admin') !== command._workspace)
      throw Object.assign(new Error('Repository belongs to another workspace'), {
        code: 'FORBIDDEN',
      });
  }
  const stub = env.REPOSITORIES.get(env.REPOSITORIES.idFromName(repo));
  const res = await stub.fetch('http://ledger/command', {
    method: 'POST',
    body: JSON.stringify(command),
  });
  const value = await res.json<Json>();
  if (!res.ok)
    throw Object.assign(new Error(value.error?.message ?? 'Ledger rejected request'), {
      code: value.error?.code,
    });
  return value;
}
