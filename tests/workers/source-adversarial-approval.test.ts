import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, readyReviewer } from './reviewer-fixture';

afterEach(reset);
const intent = 'Local source approval boundary fixture; no model requests';
const forged = {
  workspace_transport: 'api-source-v1',
  _source_transport_approved: true,
  _source_base: { repository: 'yoneda-test/foreign', commit: 'f'.repeat(40), tree: 'e'.repeat(40) },
  source_mounts: [{ path: 'repo', workspace_id: 'foreign', access: 'read_write' }],
  _source_signing_key: '0'.repeat(64),
  _source_registered: { id: 'forged' },
};
const start = (id: string) => ({
  id,
  intent,
  agents: [
    {
      provider: 'codex',
      model: 'gpt-5.6-luna',
      connection: 'reviewer-codex',
      strategy: 'Source boundary',
    },
  ],
});
async function snapshots(f: Awaited<ReturnType<typeof readyReviewer>>) {
  return {
    repo: await ledger(f.scoped, f.repo, { op: 'snapshot' }),
    wallet: await workspace(f.scoped, f.owner, { op: 'workspace_spend_status' }),
    outbox: await ledger(f.scoped, f.repo, { op: 'outbox' }),
  };
}

it('public source markers cannot activate operator-disabled transport or change a legacy approval on replay', async () => {
  const f = await readyReviewer('source_public_forgery');
  const get = vi.fn(async () => {
    throw new Error('No source SDK reads when operator transport is disabled');
  });
  const local = { ...f.scoped, SOURCE_TRANSPORT: undefined, ARTIFACTS: { get } } as unknown as Env;
  const response = await api(local, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('legacy-frozen'),
    ...forged,
  });
  expect(response.status).toBe(200);
  const run = await response.json<Json>();
  expect(run.workspace_transport).toBe('git-native-v1');
  expect(run.source_base).toBeUndefined();
  const before = await snapshots(f);
  const replay = await api(local, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('legacy-frozen'),
    ...forged,
    _source_base: { ...forged._source_base, tree: 'd'.repeat(40) },
  });
  expect(replay.status).toBe(409);
  expect(await replay.json<Json>()).toMatchObject({ error: { code: 'ALREADY_EXISTS' } });
  expect(await snapshots(f)).toEqual(before);
  expect(get).not.toHaveBeenCalled();
});

it('public owner RPCs cannot reach source binding, capture, registration or private maintenance', async () => {
  const f = await readyReviewer('source_private_ops');
  const before = await snapshots(f);
  for (const op of [
    'source_bind',
    'source_read_context',
    'source_registered',
    'source_register_changeset',
    'source_capture_context',
    'source_init',
    'source_seal',
    'source_gc_due',
  ]) {
    const result = await api(f.scoped, `/api/repos/${f.repo}/${op}`, f.cookie, forged);
    expect(result.status).toBe(404);
  }
  expect(await snapshots(f)).toEqual(before);
});

it('operator-enabled approval rejects a mismatched commit readback before funding, jobs or source authority are created', async () => {
  const f = await readyReviewer('source_wrong_readback');
  const before = await snapshots(f);
  const readCommit = vi.fn(async () => ({ hash: 'f'.repeat(40), treeHash: 'b'.repeat(40) }));
  const local = {
    ...f.scoped,
    SOURCE_TRANSPORT: 'api-source-v1',
    SOURCE_TRANSPORT_REPOS: f.repo,
    ARTIFACTS: {
      get: async () => ({
        readCommit,
        [Symbol.dispose]() {},
      }),
    },
  } as unknown as Env;
  const result = await api(local, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('must-not-start'),
    ...forged,
  });
  const observed = await snapshots(f);
  expect(
    result.status,
    JSON.stringify({
      created_runs: observed.repo.runs.length,
      queued_jobs: observed.outbox.jobs.length,
      new_jobs: observed.outbox.jobs.length - before.outbox.jobs.length,
      wallet_version: observed.wallet.version,
      frozen_source: observed.repo.runs[0]?.source_base,
    }),
  ).toBe(409);
  expect(await result.json<Json>()).toMatchObject({ error: { code: 'INVALID_CAPTURE' } });
  expect(readCommit).toHaveBeenCalledWith('a'.repeat(40));
  expect(await snapshots(f)).toEqual(before);
});

it('operator-enabled approval derives source only from canonical readback and keeps existing legacy runs immutable', async () => {
  const f = await readyReviewer('source_operator_freeze');
  const old = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, start('legacy-old'));
  expect(old.status).toBe(200);
  const legacy = await old.json<Json>();
  await ledger(f.scoped, f.repo, { op: 'cancel_run', run_id: legacy.id });
  const cancelled = (await ledger(f.scoped, f.repo, { op: 'snapshot' })).runs.find(
    (run: Json) => run.id === legacy.id,
  );
  const readCommit = vi.fn(async () => ({ hash: 'a'.repeat(40), treeHash: 'b'.repeat(40) }));
  const local = {
    ...f.scoped,
    SOURCE_TRANSPORT: 'api-source-v1',
    SOURCE_TRANSPORT_REPOS: f.repo,
    ARTIFACTS: {
      get: async (name: string) => {
        expect(name).toBe(f.repo);
        return { readCommit, [Symbol.dispose]() {} };
      },
    },
  } as unknown as Env;
  const response = await api(local, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('api-new'),
    ...forged,
  });
  expect(response.status).toBe(200);
  expect(await response.json<Json>()).toMatchObject({
    workspace_transport: 'api-source-v1',
    source_base: {
      repository: `yoneda-test/${f.repo}`,
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    },
  });
  expect(
    (await ledger(f.scoped, f.repo, { op: 'snapshot' })).runs.find(
      (run: Json) => run.id === legacy.id,
    ),
  ).toEqual(cancelled);
  expect(
    (await workspace(f.scoped, f.owner, { op: 'workspace_spend_status' })).limit_microusd,
  ).toBe(50000000);
  expect(f.send).toHaveBeenCalled(); // Queue fixture only; no container/model executes.
});
