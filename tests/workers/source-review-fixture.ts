import { expect, vi } from 'vitest';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { sourceCaptureContext } from '../../cloudflare/worker/source-capture-context';
import { sourceAgentCompletion, sourceCaptureCompletion } from '../../cloudflare/worker/source-completion';
import { hex } from '../../cloudflare/worker/source-crypto';
import { ledger, object } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { sha256 } from '../../tools/source-benchmark/workerd-source-fixture';

/** Synthetic runner observations use real SourceWS, RepoDO, R2 and evaluator transactions. */
export async function checkedSourceAlternative(env: Env, repo: string, runId: string, base: Json, index = 2) {
  const call = (command: Json) => ledger(env, repo, command);
  const producer = await call({ op: 'claim', job_id: `job:${runId}:agent-${index}` });
  const scope = (job: Json): Scope => ({ repo_id: repo, job, supervisor: 'fixture-private-root', model_calls: 0, created_at: Date.now() });
  const view = { version: 1, base, files: [] };
  const bound = await call({ op: 'source_bind', job_id: producer.id, epoch: producer.epoch, _source_view: view, _supervisor: true });
  const source = (command: Json) => sourceAuthority(env, bound.binding.workspace_id, { ...command, _actor: bound.actor_grant });
  await source({ op: 'source_init', request_id: 'init', binding: bound.binding, view, baseline_overrides: [] });
  const bytes = new Uint8Array([0, 255, index]);
  const digest = await sha256(bytes);
  const ticket = (await source({ op: 'source_upload_ticket', request_id: 'upload', path: 'app.bin',
    sha256: digest, size: bytes.length, mode: '100644', expected_workspace_version: 0, expected_file_version: 0 })).ticket;
  await env.OBJECTS.put(ticket.key, bytes);
  const uploaded = await env.OBJECTS.get(ticket.key);
  if (!uploaded) throw new Error('Synthetic source upload missing in actual R2');
  const readback = new Uint8Array(await uploaded.arrayBuffer());
  expect(readback).toEqual(bytes);
  await source({ op: 'source_verify_upload', request_id: 'verify', ticket_id: ticket.id, sha256: await sha256(readback), size: readback.length });
  await source({ op: 'source_create', request_id: 'create', path: 'app.bin', ticket_id: ticket.id,
    expected_workspace_version: 0, expected_file_version: 0 });
  const checkpoint = await source({ op: 'source_checkpoint', request_id: 'checkpoint', expected_workspace_version: 1 });
  const seal = await source({ op: 'source_seal', request_id: 'seal', expected_workspace_version: 1,
    checkpoint_id: checkpoint.checkpoint_id, expected_checkpoint_digest: checkpoint.changeset_digest });
  const registration = await call({ op: 'source_register_changeset', request_id: 'register', job_id: producer.id,
    epoch: producer.epoch, view_digest: bound.binding.view_digest, _source_seal: seal });
  const completion = await sourceAgentCompletion(env, scope(producer), {
    source_workspace: { transport: 'api-source-v1', checked: false, published: false, mounts: { repo: {
      workspace_id: bound.binding.workspace_id, seal_id: seal.seal_id, checkpoint_id: seal.checkpoint_id,
      changeset_digest: seal.changeset_digest, workspace_version: 1 } } },
  });
  await call({ op: 'finish', job_id: producer.id, epoch: producer.epoch, result: completion });
  const pending = await call({ op: 'run_detail', run_id: runId });
  expect(pending.run.comparison.review_execution_id).toBeFalsy();
  const capture = await call({ op: 'claim', job_id: `capture:${runId}:agent-${index}` });
  const context = await sourceCaptureContext(env, scope(capture));
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const gitBytes = new Uint8Array(header.length + bytes.length);
  gitBytes.set(header); gitBytes.set(bytes, header.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', gitBytes));
  const id = `checked-source-${index}`;
  const revision = { repository: `yoneda-test/checked-source-${index}`, commit: String(index + 1).repeat(40) };
  const tree = 'd'.repeat(40);
  const result = { id, revision, tree, parents: context.parents, paths: ['app.bin'],
    summary: 'Synthetic independently captured source', source_changeset_digest: registration.changeset_digest,
    source_manifest_digest: registration.changeset_digest,
    file_provenance: [{ path: 'app.bin', change: 'add', old_blob: null, new_blob: blob }] };
  const verified = await sourceCaptureCompletion(env, scope(capture), result);
  await call({ op: 'finish', job_id: capture.id, epoch: capture.epoch,
    result: { ...result, source_verified: true, source_lineage: verified.lineage } });
  const checking = await call({ op: 'run_detail', run_id: runId });
  expect(checking.run.comparison.review_execution_id).toBeFalsy();
  expect(checking.candidates.find((candidate: Json) => candidate.id === id).status).toBe('evaluating');
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${id}` });
  const policy = evaluator.payload.policy;
  const files = { 'index.html': { content: '<!doctype html><title>Synthetic checked source</title>' } };
  const site = await object(env, JSON.stringify({ repo, revision, files }));
  await call({ op: 'register_site', job_id: evaluator.id, epoch: evaluator.epoch, digest: site.digest, files });
  const evidence = await object(env, 'Synthetic evaluator observations; no live command or model execution');
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch, evidence: evidence.digest,
    report: { suite: policy.suite, environment: policy.environment,
      setup: policy.build.setup.map((check: Json) => ({ name: check.name, output: { exit: 0 } })),
      commands: policy.build.checks.map((check: Json) => ({ name: check.name, output: { exit: 0 } })) } });
  const checked = await call({ op: 'run_detail', run_id: runId });
  expect(checked.candidates.find((candidate: Json) => candidate.id === id)).toMatchObject({ status: 'eligible', revision });
  expect(checked.run.model_requests).toBe(0);
  return { id, revision, tree, blob, bytes };
}

/** Only the captured revisions can be opened; the failed original base is unreadable. */
export function reviewSourceEnv(env: Env, candidates: Awaited<ReturnType<typeof checkedSourceAlternative>>[]) {
  const get = vi.fn(async (name: string) => {
    const candidate = candidates.find((value) => value.revision.repository === `yoneda-test/${name}`);
    if (!candidate) throw new Error('Uncaptured or original source must not be opened by review');
    return { readCommit: async () => ({ hash: candidate.revision.commit, treeHash: candidate.tree }),
      readTree: async () => [{ name: 'app.bin', type: 'blob', mode: '100644', hash: candidate.blob }],
      readBlob: async () => new Blob([candidate.bytes]), [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  });
  const send = vi.fn();
  return { env: { ...env, ARTIFACTS: { get }, AGENT_QUEUE: { send } } as unknown as Env, get, send };
}
