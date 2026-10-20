// A lazy-source candidate captured onto the real platform: the producer seals its changes in
// the real SourceWS/R2, capture commits them through the broker's `commit` operation onto the
// attempt's assigned candidate branch, and the evaluator's (synthetic) observations pass.
import { captureResult } from '../../cloudflare/worker/capture-result';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { sourceCapture } from '../../cloudflare/worker/source-capture';
import { sourceCaptureContext } from '../../cloudflare/worker/source-capture-context';
import { sourceAgentCompletion } from '../../cloudflare/worker/source-completion';
import { prepareSourceDispatch } from '../../cloudflare/worker/source-dispatch';
import { ledger, object } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { sha256 } from '../../tools/source-benchmark/workerd-source-fixture';
import { base64, gitSnapshot } from './platform-fixture';

const encoder = new TextEncoder();
export const attempt = (repo: string, job: Json): Scope =>
  ({ repo_id: repo, job, supervisor: 'fixture-private-root', model_calls: 0, created_at: Date.now() });

/** Seal new files in the producer's SourceWS and finish it; returns the capture job. */
export async function sealedProducer(env: Env, repo: string, execution: string, base: Json, files: Record<string, string>) {
  const call = (command: Json) => ledger(env, repo, command);
  const producer = await call({ op: 'claim', job_id: `job:${execution}` });
  const view = { version: 1, base, files: [] };
  const bound = await call({ op: 'source_bind', job_id: producer.id, epoch: producer.epoch, _source_view: view, _supervisor: true });
  const source = (command: Json) => sourceAuthority(env, bound.binding.workspace_id, { ...command, _actor: bound.actor_grant });
  await source({ op: 'source_init', request_id: 'init', binding: bound.binding, view, baseline_overrides: [] });
  let version = 0;
  for (const [path, text] of Object.entries(files)) {
    const bytes = encoder.encode(text);
    const ticket = (await source({ op: 'source_upload_ticket', request_id: `upload:${path}`, path,
      sha256: await sha256(bytes), size: bytes.length, mode: '100644', expected_workspace_version: version,
      expected_file_version: 0 })).ticket;
    await env.OBJECTS.put(ticket.key, bytes);
    await source({ op: 'source_verify_upload', request_id: `verify:${path}`, ticket_id: ticket.id,
      sha256: await sha256(bytes), size: bytes.length });
    await source({ op: 'source_create', request_id: `create:${path}`, path, ticket_id: ticket.id,
      expected_workspace_version: version, expected_file_version: 0 });
    version++;
  }
  const checkpoint = await source({ op: 'source_checkpoint', request_id: 'checkpoint', expected_workspace_version: version });
  const seal = await source({ op: 'source_seal', request_id: 'seal', expected_workspace_version: version,
    checkpoint_id: checkpoint.checkpoint_id, expected_checkpoint_digest: checkpoint.changeset_digest });
  await call({ op: 'source_register_changeset', request_id: 'register', job_id: producer.id,
    epoch: producer.epoch, view_digest: bound.binding.view_digest, _source_seal: seal });
  const completion = await sourceAgentCompletion(env, attempt(repo, producer), {
    source_workspace: { transport: 'api-source-v1', checked: false, published: false, mounts: { repo: {
      workspace_id: bound.binding.workspace_id, seal_id: seal.seal_id, checkpoint_id: seal.checkpoint_id,
      changeset_digest: seal.changeset_digest, workspace_version: version } } },
  });
  await call({ op: 'finish', job_id: producer.id, epoch: producer.epoch, result: completion });
  return { seal, capture: await call({ op: 'claim', job_id: `capture:${execution}` }) };
}

/** The runtime's capture: commit the sealed files onto the dispatch-assigned branch. */
export async function commitSealed(env: Env, scope: Scope, baseFiles: Record<string, string>, files: Record<string, string>) {
  if ((await prepareSourceDispatch(env, scope)) !== 'ready') throw new Error('Capture dispatch deferred');
  const context = await sourceCaptureContext(env, scope);
  const tree = (await gitSnapshot({ ...baseFiles, ...files })).root;
  const body = { parents: context.parents, tree, message: 'Sealed source',
    changes: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', content_b64: base64(encoder.encode(text)) })) };
  const committed = await (await sourceCapture(env, scope, 'commit', body)).json<Json>();
  return { context, body, committed };
}

/** A checked, eligible lazy-source candidate whose capture is a real platform commit. */
export async function lazyCandidate(env: Env, repo: string, execution: string, base: Json,
  baseFiles: Record<string, string>, files: Record<string, string>) {
  const call = (command: Json) => ledger(env, repo, command);
  const { seal, capture } = await sealedProducer(env, repo, execution, base, files);
  const scope = attempt(repo, capture);
  const { context, committed } = await commitSealed(env, scope, baseFiles, files);
  const id = `candidate-${execution.replaceAll(':', '-')}`;
  const finish = await captureResult(env, scope, { id, revision: committed.revision, tree: committed.tree,
    parents: context.parents, summary: 'Sealed platform capture', diff: `Sealed changes for ${id}`,
    source_changeset_digest: seal.changeset_digest, source_manifest_digest: seal.changeset_digest });
  await call(finish);
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${id}` });
  const policy = evaluator.payload.policy;
  const site = { 'index.html': { content: `<!doctype html><title>${id}</title>` } };
  await call({ op: 'register_site', job_id: evaluator.id, epoch: evaluator.epoch,
    digest: (await object(env, JSON.stringify({ repo, revision: committed.revision, files: site }))).digest, files: site });
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch,
    evidence: (await object(env, `Synthetic evaluator observations for ${id}`)).digest,
    report: { suite: policy.suite, environment: policy.environment,
      setup: policy.build.setup.map((check: Json) => ({ name: check.name, output: { exit: 0 } })),
      commands: policy.build.checks.map((check: Json) => ({ name: check.name, output: { exit: 0 } })) } });
  return { id, revision: committed.revision as Json, tree: committed.tree as string, branch: scope.job.source_capture_ref.branch as string };
}
