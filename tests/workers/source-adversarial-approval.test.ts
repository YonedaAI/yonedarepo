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
  _source_base: { repository: 'platform/foreign', commit: 'f'.repeat(40), tree: 'e'.repeat(40) },
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

it('public source markers are replaced by canonical readback and cannot change an approval on replay', async () => {
  const f = await readyReviewer('source_public_forgery');
  const local = f.scoped;
  const response = await api(local, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('forged-markers'),
    ...forged,
  });
  expect(response.status).toBe(200);
  const run = await response.json<Json>();
  // A forged lazy-source marker cannot choose the retired harness: every run is a sandbox run.
  expect(run.workspace_transport).toBe('sandbox-cli-v1');
  expect(run.source_base).toEqual({ repository: `platform/${f.repo}`, commit: f.head, tree: f.tree });
  expect(run.source_mounts).toBeUndefined();
  const before = await snapshots(f);
  const replay = await api(local, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('forged-markers'),
    ...forged,
    _source_base: { ...forged._source_base, tree: 'd'.repeat(40) },
  });
  expect(replay.status).toBe(409);
  expect(await replay.json<Json>()).toMatchObject({ error: { code: 'ALREADY_EXISTS' } });
  expect(await snapshots(f)).toEqual(before);
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

it('approval rejects a mismatched commit readback before funding, jobs or source authority are created', async () => {
  const f = await readyReviewer('source_wrong_readback');
  const before = await snapshots(f);
  // The platform answers the head read with a different commit than the one requested.
  const requested: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    const answer = await f.scoped.SELF.fetch(request.clone());
    if (!new URL(request.url).pathname.endsWith('/objects')) return answer;
    requested.push(...(await request.json<Json>()).objects.map((o: Json) => o.id));
    const value = await answer.json<Json>();
    return Response.json({ ...value, objects: value.objects.map((o: Json) => ({ ...o, id: 'f'.repeat(40) })) });
  });
  const local = { ...f.scoped, PLATFORM: { fetch } } as unknown as Env;
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
  expect(requested).toEqual([f.head]);
  expect(await snapshots(f)).toEqual(before);
});

it('approval derives source only from canonical readback and keeps earlier runs immutable', async () => {
  const f = await readyReviewer('source_operator_freeze');
  const old = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, start('earlier'));
  expect(old.status).toBe(200);
  const earlier = await old.json<Json>();
  await ledger(f.scoped, f.repo, { op: 'cancel_run', run_id: earlier.id });
  const cancelled = (await ledger(f.scoped, f.repo, { op: 'snapshot' })).runs.find(
    (run: Json) => run.id === earlier.id,
  );
  const response = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, {
    ...start('api-new'),
    ...forged,
  });
  expect(response.status).toBe(200);
  expect(await response.json<Json>()).toMatchObject({
    workspace_transport: 'sandbox-cli-v1',
    source_base: { repository: `platform/${f.repo}`, commit: f.head, tree: f.tree },
  });
  expect(
    (await ledger(f.scoped, f.repo, { op: 'snapshot' })).runs.find(
      (run: Json) => run.id === earlier.id,
    ),
  ).toEqual(cancelled);
  expect(
    (await workspace(f.scoped, f.owner, { op: 'workspace_spend_status' })).limit_microusd,
  ).toBe(50000000);
  expect(f.send).toHaveBeenCalled(); // Queue fixture only; no sandbox or model executes.
});
