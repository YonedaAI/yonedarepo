import { sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { bindings } from './workerd-source-fixture';

/** Synthetic external SDK and Container RPC; both source and repository ledgers are real DOs. */
export async function boundSourceFixture(name: string) {
  const base = { repository: `yoneda-test/${name}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bytes = new TextEncoder().encode('source fixture');
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', object))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const repo = {
    [Symbol.dispose]() {},
    readCommit: async (commit: string) => {
      if (commit !== base.commit) throw new Error('Unapproved commit');
      return { hash: base.commit, treeHash: base.tree };
    },
    readTree: async (tree: string) => {
      if (tree !== base.tree) throw new Error('Unapproved tree');
      return [{ name: 'app.js', hash, mode: '100644', type: 'blob' }];
    },
    readBlob: async (blob: string) => {
      if (blob !== hash) throw new Error('Unapproved blob');
      return new Blob([bytes]);
    },
  } as unknown as ArtifactsRepo;
  const call = (input: Json) => ledger(bindings, name, input);
  await call({
    op: 'init',
    id: name,
    name,
    workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name },
    commit: base.commit,
    policy: reviewerPolicy,
  });
  await call({
    op: 'start_run',
    id: 'run-source',
    intent: 'No-inference source boundary fixture',
    workspace_transport: 'api-source-v1',
    _source_transport_approved: true,
    _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'boundary fixture' }],
  });
  const job = await call({ op: 'claim', job_id: 'job:run-source:agent-1' });
  const scope: Scope = {
    repo_id: name,
    job,
    supervisor: 'local-fixture-root-capability',
    model_calls: 0,
    created_at: Date.now(),
  };
  const invalidations: Json[] = [];
  const local = {
    ...bindings,
    ARTIFACTS: {
      get: async (repoName: string) => {
        if (repoName !== name) throw new Error('Unapproved repository');
        return repo;
      },
    },
    EXECUTIONS: {
      idFromString: (id: string) => id,
      get: () => ({
        scope: async () => scope,
        invalidateSource: async (input: Json) => {
          invalidations.push(input);
          return { ...input, invalidated: true };
        },
      }),
    },
  } as unknown as Env;
  if ((await sourceIndexBounded(local, base)).state !== 'prepared')
    throw new Error('Fixture source is not ready');
  const context = await sourceScope(local, scope, 'repo', true);
  return { env: local, scope, context, call, invalidations };
}
