import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceBroker } from '../../cloudflare/worker/source-broker';
import { cacheSourceBlob } from '../../cloudflare/worker/source-cache';
import { publicSourceValue } from '../../cloudflare/worker/source-operations';
import { sourceContentKey, sourceReadResponse } from '../../cloudflare/worker/source-storage';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { artifactsBenchmarkFixture } from '../../tools/source-benchmark/workerd-artifacts-fixture';
import { syntheticPlatform } from './platform-fixture';
import { bindings, sourceFixture } from '../../tools/source-benchmark/workerd-source-fixture';
import { approvedLedger } from './source-kit';

afterEach(reset);

async function containerFixture() {
  const repo = 'source-transport-fence';
  const policy = {
    version: 'source-fence-v1',
    suite: 'commands-v1',
    environment: 'linux-node24-rust1.94-v1',
    required_checks: ['build'],
    build: {
      setup: [],
      checks: [{ name: 'build', argv: ['true'], timeout_seconds: 30 }],
      static_dir: 'public',
    },
  };
  await ledger(bindings, repo, {
    op: 'init',
    id: repo,
    name: 'Source fencing fixture',
    remote: { namespace: 'platform', name: repo, branch: 'main' },
    commit: 'a'.repeat(40),
    policy,
  });
  await approvedLedger(bindings, repo)({
    op: 'start_run',
    id: 'source-fence',
    intent: 'Source boundary test',
    agents: [{ provider: 'claude', model: 'claude-sonnet-5-5', strategy: 'source' }],
  });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:source-fence:agent-1' });
  let storageCalls = 0;
  const local = {
    ...bindings,
    EXECUTIONS: {
      idFromString: (id: string) => id,
      get: () => ({ scope: async () => ({ repo_id: repo, job, supervisor: 'fixture-root-only' }) }),
    },
    OBJECTS: new Proxy(bindings.OBJECTS, {
      get(target, key) {
        storageCalls++;
        return Reflect.get(target, key);
      },
    }),
    ARTIFACTS: {
      get: async () => {
        throw new Error('Source body must not access Artifacts');
      },
    },
  } as unknown as Env;
  const call = (op: string, body: Json = {}, supervisor = false) =>
    sourceBroker(
      new Request(`http://source.yoneda.internal/v1/repo/${op}`, {
        method: 'POST',
        headers: supervisor ? { authorization: 'Bearer fixture-root-only' } : {},
        body: JSON.stringify(body),
      }),
      local,
      { containerId: 'container-fixture' } as any,
    );
  return { repo, job, call, storageCalls: () => storageCalls };
}

it('cancelled container attempts cannot read, mutate, upload or seal even with a still-known root token', async () => {
  const f = await containerFixture();
  await ledger(bindings, f.repo, { op: 'cancel_run', run_id: 'source-fence' });
  for (const op of ['source_status', 'source_read', 'source_write', 'source_seal']) {
    const result = await f.call(op, { job_id: f.job.id, epoch: f.job.epoch }, true);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'FENCED' } });
  }
  expect(f.storageCalls()).toBe(0);
});

it('active model requests cannot supply private grants, alternate identities or supervisor-only transitions', async () => {
  const f = await containerFixture();
  for (const [op, args] of [
    ['source_status', { _actor: { signature: '0'.repeat(64) } }],
    ['source_read', { path: 'src/read.bin', expected_file_version: 0, workspace_id: 'foreign' }],
    [
      'source_status',
      { provider: 'claude', job_id: 'foreign', _source_signing_key: '0'.repeat(64) },
    ],
    ['source_verify_upload', { ticket_id: 'foreign' }],
    ['source_gc_due', {}],
    ['source_seal', {}],
  ] as [string, Json][]) {
    const result = await f.call(op, args);
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  }
  expect(f.storageCalls()).toBe(0);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).repository.published_commit).toBe(
    'a'.repeat(40),
  );
});

it('warm digest cache cannot authorize a foreign origin path and public range responses omit storage pointers', async () => {
  const artifacts = artifactsBenchmarkFixture();
  const path = artifacts.requested[0];
  const entries = await artifacts.repo.readTree(
    (await artifacts.repo.readTree(artifacts.base.tree))[0].hash,
  );
  const leaf = await artifacts.repo.readTree(entries[0].hash);
  const blob = leaf[0].hash;
  const local = await syntheticPlatform(bindings, { 'source-base': artifacts.repo });
  await cacheSourceBlob(local, artifacts.repo, artifacts.base, blob);
  const content = {
    kind: 'git',
    repository: artifacts.base.repository,
    commit: artifacts.base.commit,
    path,
    blob,
  };
  const f = await sourceFixture('cache-idor', {
    base: artifacts.base,
    files: [{ path, mode: '100644', size: 4096, content }],
    write_paths: ['**'],
    protected_paths: [],
  });
  const authorized = await f.rpc({
    op: 'source_read',
    path,
    expected_file_version: 0,
    offset: 1,
    limit: 8,
  });
  for (const forged of [
    { ...content, path: artifacts.requested[1] },
    { ...content, repository: 'platform/foreign' },
    { ...content, commit: 'f'.repeat(40) },
    { ...content, path: '../escape' },
  ])
    await expect(sourceContentKey(local, f.binding, forged as any, 4096)).rejects.toHaveProperty(
      'code',
    );
  const response = await sourceReadResponse(local, f.binding, authorized);
  expect((await response.arrayBuffer()).byteLength).toBe(8);
  const metadata = JSON.parse(decodeURIComponent(response.headers.get('x-yoneda-source')!));
  expect(metadata.content).toBeUndefined();
  expect(metadata.file.content).toBeUndefined();
  expect(JSON.stringify(publicSourceValue(await f.rpc({ op: 'source_stat', path })))).not.toContain(
    'content',
  );
  expect(artifacts.counts().blob_reads).toBe(1);
});
