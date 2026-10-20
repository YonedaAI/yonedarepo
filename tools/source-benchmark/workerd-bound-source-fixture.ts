import { sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { openSource } from '../../cloudflare/worker/source-objects';
import { syntheticPlatform } from '../../tests/workers/platform-fixture';
import { bindings } from './workerd-source-fixture';

/** Synthetic external SDK and Container RPC; both source and repository ledgers are real DOs. */
export async function boundSourceFixture(name: string) {
  const base = { repository: `platform/${name}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
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
  };
  const call = (input: Json) => ledger(bindings, name, input);
  // The project's platform repository answers with the synthetic objects above.
  const platform = await syntheticPlatform(bindings, { [name]: repo }, 'source_owner');
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
    ...platform,
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
  return { env: local, scope, context, call, invalidations, repo: await openSource(local, base.repository) };
}
