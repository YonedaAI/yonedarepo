import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import {
  sourceCaptureContext,
  sourceCaptureManifest,
} from '../../cloudflare/worker/source-capture-context';
import {
  sourceAgentCompletion,
  sourceCaptureCompletion,
} from '../../cloudflare/worker/source-completion';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json, Scope } from '../../cloudflare/worker/types';
import { bindings, sha256 } from '../../tools/source-benchmark/workerd-source-fixture';
import { resolveRunRoster } from '../../cloudflare/worker/run-roster';
import { approvedLedger } from './source-kit';

const policy = {
  version: 'comparison-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: { setup: [], checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }], static_dir: 'public' },
};
/** A two-builder compare roster from saved connections, as the owner's approval resolves it. */
function compareApproval() {
  const connections = [
    { id: 'sol-builder', provider: 'codex', model: 'gpt-6-sol', version: 1 },
    { id: 'sonnet-builder', provider: 'claude', model: 'claude-sonnet-5-5', version: 1 },
  ];
  return resolveRunRoster({ mode: 'compare', adaptive_team: { version: 1, requested_agents: [
    { connection: 'sol-builder', role: 'builder' },
    { connection: 'sonnet-builder', role: 'builder' },
  ] } }, connections, 50000000);
}

afterEach(reset);
const repo = 'source-capture-epoch';
const runId = 'epoch-run';
const producerId = `job:${runId}:agent-1`;
const captureId = `capture:${runId}:agent-1`;
const candidateId = 'epoch-candidate';
const base = { repository: `yoneda-test/${repo}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const call = approvedLedger(bindings, repo);
const repository = () => bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
const scope = (job: Json): Scope => ({
  repo_id: repo,
  job,
  supervisor: 'synthetic-private-root',
  model_calls: 0,
  created_at: Date.now(),
});

async function stored(table: 'jobs' | 'nodes', id: string): Promise<Json> {
  return runInDurableObject(repository(), (_instance, state) => {
    const row = state.storage.sql.exec(`SELECT payload FROM ${table} WHERE id=?`, id).toArray()[0];
    return row ? JSON.parse(String(row.payload)) : null;
  });
}

async function prepareRegisteredSource() {
  await call({
    op: 'init',
    id: repo,
    name: 'Actual Wasm epoch provenance',
    workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name: repo },
    commit: base.commit,
    policy,
  });
  await call({
    ...compareApproval(),
    op: 'start_run',
    id: runId,
    intent: 'Capture the exact registered source after preparation',
    workspace_transport: 'api-source-v1',
    _source_transport_approved: true,
    _source_base: base,
  });
  const first = await call({ op: 'claim', job_id: producerId });
  expect(first.epoch).toBe(1);
  const deferred = await call({
    op: 'defer_job',
    job_id: producerId,
    epoch: first.epoch,
    reason: 'source_preparing',
  });
  expect(deferred).toMatchObject({ epoch: 2, attempt: 0, deadline: first.deadline });
  // Wait for the real five-second native defer clock; do not forge the epoch or lease.
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, deferred.not_before - Date.now()) + 20),
  );
  const producer = await call({ op: 'claim', job_id: producerId });
  expect(producer).toMatchObject({ epoch: 3, attempt: 1 });
  expect(producer.payload.execution.epoch).toBeUndefined();
  // Synthetic local usage settlement exercises real Wasm counters; no provider is contacted.
  const reservation = await call({
    op: 'reserve_request',
    job_id: producerId,
    epoch: 3,
    kind: 'model',
    input_bytes: 100,
    output_tokens: 256,
  });
  await call({
    op: 'settle_model_request',
    job_id: producerId,
    epoch: 3,
    reservation_id: reservation.reservation_id,
    input_tokens: 100,
    output_tokens: 1,
  });
  const view = { version: 1, base, files: [] };
  const bound = await call({
    op: 'source_bind',
    job_id: producerId,
    epoch: 3,
    _source_view: view,
    _supervisor: true,
  });
  const source = (command: Json) =>
    sourceAuthority(bindings, bound.binding.workspace_id, {
      ...command,
      _actor: bound.actor_grant,
    });
  await source({
    op: 'source_init',
    request_id: 'init',
    binding: bound.binding,
    view,
    baseline_overrides: [],
  });
  const bytes = new TextEncoder().encode('export const captured = true;\n');
  const digest = await sha256(bytes);
  const issued = await source({
    op: 'source_upload_ticket',
    request_id: 'ticket',
    path: 'app.js',
    sha256: digest,
    size: bytes.length,
    mode: '100644',
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  await bindings.OBJECTS.put(issued.ticket.key, bytes);
  const object = await bindings.OBJECTS.get(issued.ticket.key);
  if (!object) throw new Error('Actual R2 fixture upload missing');
  const readback = new Uint8Array(await object.arrayBuffer());
  expect(readback).toEqual(bytes);
  await source({
    op: 'source_verify_upload',
    request_id: 'verify',
    ticket_id: issued.ticket.id,
    sha256: await sha256(readback),
    size: readback.length,
  });
  await source({
    op: 'source_create',
    request_id: 'create',
    path: 'app.js',
    ticket_id: issued.ticket.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  const checkpoint = await source({
    op: 'source_checkpoint',
    request_id: 'checkpoint',
    expected_workspace_version: 1,
  });
  const seal = await source({
    op: 'source_seal',
    request_id: 'seal',
    expected_workspace_version: 1,
    checkpoint_id: checkpoint.checkpoint_id,
    expected_checkpoint_digest: checkpoint.changeset_digest,
  });
  const registration = await call({
    op: 'source_register_changeset',
    request_id: 'register',
    job_id: producerId,
    epoch: 3,
    view_digest: bound.binding.view_digest,
    _source_seal: seal,
  });
  expect(registration).toMatchObject({
    changeset_digest: checkpoint.changeset_digest,
    binding: { epoch: 3, job_id: producerId },
  });
  const completion = await sourceAgentCompletion(bindings, scope(producer), {
    execution_epoch: 999,
    source_registered: { producer_epoch: 999 },
    source_workspace: {
      transport: 'api-source-v1',
      checked: false,
      published: false,
      mounts: {
        repo: {
          workspace_id: bound.binding.workspace_id,
          seal_id: seal.seal_id,
          checkpoint_id: seal.checkpoint_id,
          changeset_digest: seal.changeset_digest,
          workspace_version: 1,
        },
      },
    },
  });
  await call({ op: 'finish', job_id: producerId, epoch: 3, result: completion });
  const capture = await call({ op: 'claim', job_id: captureId });
  expect(capture).toMatchObject({
    epoch: 1,
    kind: 'capture',
    payload: {
      execution: { epoch: 3 },
      source_registered: {
        producer_job_id: producerId,
        producer_epoch: 3,
        registration_id: registration.registration_id,
      },
    },
  });
  const context = await sourceCaptureContext(bindings, scope(capture));
  expect(context._capture_grant.claims).toMatchObject({
    capture_job_id: captureId,
    capture_epoch: 1,
  });
  const manifest = await sourceCaptureManifest(bindings, context, 'changes', null, 200);
  expect(manifest.items).toHaveLength(1);
  expect(manifest.items[0]).toMatchObject({
    path: 'app.js',
    before: null,
    after: {
      content: { kind: 'r2', key: issued.ticket.key, sha256: digest, ticket_id: issued.ticket.id },
    },
  });
  const result = {
    id: candidateId,
    revision: { repository: 'yoneda-test/epoch-captured', commit: 'c'.repeat(40) },
    tree: 'd'.repeat(40),
    parents: context.parents,
    paths: ['app.js'],
    summary: 'Synthetic Git readback of registered R2 source',
    source_changeset_digest: registration.changeset_digest,
    source_manifest_digest: registration.changeset_digest,
    file_provenance: [{ path: 'app.js', change: 'add', old_blob: null, new_blob: 'e'.repeat(40) }],
  };
  const verified = await sourceCaptureCompletion(bindings, scope(capture), result);
  return {
    capture,
    registration,
    result: { ...result, source_verified: true, source_lineage: verified.lineage },
  };
}

it('roundtrips a real deferred epoch-three producer through SourceWS/R2 and epoch-one capture with nonempty provenance', async () => {
  const f = await prepareRegisteredSource();
  const before = (await call({ op: 'run_detail', run_id: runId })).run;
  expect(before.model_requests).toBe(1);
  expect(before.model_budgets.some((budget: Json) => budget.charged_microusd > 0)).toBe(true);
  const producer = await stored('jobs', producerId);
  const finish = { op: 'finish', job_id: captureId, epoch: 1, result: f.result };
  // Recreate the production omission in test-only durable data, keeping live identity intact.
  await runInDurableObject(repository(), (_instance, state) => {
    const malformed = structuredClone(f.capture);
    delete malformed.payload.execution.epoch;
    state.storage.sql.exec(
      'UPDATE jobs SET payload=? WHERE id=?',
      JSON.stringify(malformed),
      captureId,
    );
  });
  await expect(call(finish)).rejects.toMatchObject({
    code: 'FENCED',
    message: 'Capture execution identity changed',
  });
  expect(await stored('nodes', `file-receipt:${candidateId}:0`)).toBeNull();
  expect(await stored('jobs', `evaluate:${candidateId}`)).toBeNull();
  expect((await call({ op: 'run_detail', run_id: runId })).candidates).toHaveLength(0);
  await runInDurableObject(repository(), (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE jobs SET payload=? WHERE id=?',
      JSON.stringify(f.capture),
      captureId,
    );
  });
  await call(finish);
  await expect(call(finish)).rejects.toMatchObject({ code: 'FENCED' });
  const detail = await call({ op: 'run_detail', run_id: runId });
  expect(detail.candidates).toHaveLength(1);
  expect(detail.candidates[0]).toMatchObject({
    id: candidateId,
    source_lineage: f.result.source_lineage,
    status: 'evaluating',
  });
  const file = await stored('nodes', `file-receipt:${candidateId}:0`);
  expect(file).toMatchObject({
    kind: 'file_provenance',
    author: 'platform_capture',
    data: {
      execution_epoch: 3,
      capture_epoch: 1,
      execution_id: `${runId}:agent-1`,
      candidate: candidateId,
      path: 'app.js',
      change: 'add',
      old_blob: null,
      new_blob: 'e'.repeat(40),
      authority: 'trusted_capture',
    },
  });
  expect(file.data.revision).toEqual(f.result.revision);
  expect(await stored('jobs', `evaluate:${candidateId}`)).toMatchObject({
    status: 'queued',
    kind: 'evaluate',
  });
  expect(await call({ op: 'source_registered', job_id: producerId })).toEqual(f.registration);
  expect(await stored('jobs', producerId)).toEqual(producer);
  for (const field of [
    'agents',
    'policy',
    'base',
    'model_requests',
    'model_budgets',
    'execution_count',
    'workspace_spend',
  ])
    expect(detail.run[field]).toEqual(before[field]);
  expect(detail.run.comparison).toEqual(before.comparison);
  expect((await call({ op: 'repository_status' })).head_commit).toBe(base.commit);
}, 30000);
