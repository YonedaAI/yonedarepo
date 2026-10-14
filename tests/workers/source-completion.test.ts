import { expect, it } from 'vitest';
import { sourceAgentCompletion } from '../../cloudflare/worker/source-completion';
import type { Env, Scope } from '../../cloudflare/worker/types';

const registration = { registration_id: 'registered', changeset_digest: 'a'.repeat(64), seal_id: 'seal', checkpoint_id: 'checkpoint',
  workspace_version: 4, binding: { workspace_id: 'workspace', repo_id: 'source-completion', job_id: 'job:builder', epoch: 2 } };
const scope = { repo_id: 'source-completion', job: { id: 'job:builder', epoch: 2 } } as Scope;
const bindings = { REPOSITORIES: { idFromName: (name: string) => name, get: () => ({ fetch: async (_url: string, input: RequestInit) => {
  const command = JSON.parse(String(input.body));
  expect(command).toEqual({ op: 'source_registered', job_id: 'job:builder' });
  return Response.json(registration);
} }) } } as unknown as Env;
const body = () => ({ transcript: 'b'.repeat(64), source_workspace: { transport: 'api-source-v1', checked: false, published: false,
  mounts: { repo: { workspace_id: 'workspace', seal_id: 'seal', checkpoint_id: 'checkpoint', changeset_digest: 'a'.repeat(64), workspace_version: 4 } } } });

it('replaces caller-supplied completion authority with the independently registered exact producer seal', async () => {
  const result = await sourceAgentCompletion(bindings, scope, { ...body(), source_verified: false,
    source_registered: { registration_id: 'forged', producer_epoch: 99 }, workspace: 'legacy', git_verified: true });
  expect(result.source_verified).toBe(true);
  expect(result.source_registered).toEqual({ producer_job_id: 'job:builder', producer_epoch: 2, registration_id: 'registered', changeset_digest: 'a'.repeat(64) });
  expect(result.workspace).toBeUndefined();
  expect(result.git_verified).toBeUndefined();
  expect(result.source_workspace).toBeUndefined();
});
it('rejects a different seal, workspace version or captured-authority claim before native completion', async () => {
  for (const key of ['workspace_id', 'seal_id', 'checkpoint_id', 'changeset_digest', 'workspace_version']) {
    const forged = body();
    Object.assign(forged.source_workspace.mounts.repo, { [key]: 'foreign' });
    await expect(sourceAgentCompletion(bindings, scope, forged)).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  }
  await expect(sourceAgentCompletion(bindings, scope, { ...body(), source_workspace: { ...body().source_workspace, checked: true } }))
    .rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
});
