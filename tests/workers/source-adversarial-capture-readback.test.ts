import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { captureResult } from '../../cloudflare/worker/capture-result';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';
import { platformCommit, platformProject } from './platform-fixture';

afterEach(reset);

it('capture readback rejects a different returned commit hash before storing capture evidence', async () => {
  const project = await platformProject(bindings, 'capture_owner', 'source-capture-hash', { 'file.txt': 'base\n' }, {
    version: 'v1',
    required_checks: ['retry'],
    suite: 'retry-contract-v1',
    environment: 'linux-rust-1.94-v1',
  });
  const base = project.base.commit;
  const captured = await platformCommit(project.platform, base, { 'file.txt': 'captured\n' });
  const branch = 'agents/capture-readback-fixture';
  await project.platform.call('POST', '/branches', { ref: branch, commit: captured.commit, expected: null });
  // The platform answers the captured commit read with a different object id.
  const env = {
    ...bindings,
    PLATFORM: {
      async fetch(input: RequestInfo, init?: RequestInit) {
        const request = new Request(input, init);
        const answer = await bindings.SELF.fetch(request.clone());
        if (!new URL(request.url).pathname.endsWith('/objects')) return answer;
        const value = await answer.json<Json>();
        return Response.json({
          ...value,
          objects: value.objects.map((o: Json) => (o.id === captured.commit ? { ...o, id: 'f'.repeat(40) } : o)),
        });
      },
    },
  } as unknown as Env;
  const scope = {
    repo_id: 'source-capture-hash',
    job: {
      id: 'capture-fixture',
      kind: 'capture',
      epoch: 1,
      source_capture_ref: { branch },
      payload: { base: project.base },
    },
  } as unknown as Scope;
  await expect(
    captureResult(env, scope, {
      id: 'candidate',
      revision: { repository: project.base.repository, commit: captured.commit },
      tree: captured.tree,
      parents: [base],
      diff: 'Synthetic readback only; no Git push',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  expect((await bindings.OBJECTS.list({ prefix: 'sha256/' })).objects).toHaveLength(0);
});
