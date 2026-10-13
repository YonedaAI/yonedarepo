import { expect, it } from 'vitest';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';
import { gitRole } from '../../cloudflare/worker/git-policy';
import type { Scope } from '../../cloudflare/worker/types';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { comparisonManifestFingerprint } from '../../cloudflare/worker/comparison-context';

it('defers comparison review before model calls until both native boundaries support it', () => {
  const snapshot = { capabilities: { artifact_reads: 2 } };
  expect(() => checkLedger(snapshot, { comparison: { version: 1 } })).toThrow('updating');
  expect(() => checkLedger({ capabilities: { ...snapshot.capabilities, comparison_review: 1 } }, { comparison: { version: 1 } })).not.toThrow();
  const job = { kind: 'agent', payload: { review_only: true, comparison_review: true } };
  expect(() => checkRuntime({ protocol: 2, capabilities: {} }, job)).toThrow('review');
  try { checkRuntime({ protocol: 2, capabilities: {} }, job); } catch (error) {
    expect(error).toMatchObject({ code: 'RUNTIME_UPDATING' });
  }
  expect(() => checkRuntime({ protocol: 2, capabilities: { comparison_review: 1 } }, job)).not.toThrow();
});

it('matches the Rust native fingerprint domain for frozen manifest identities', async () => {
  expect(await comparisonManifestFingerprint({ version: 1 })).toBe('e956c344aed0e83828344493c093ae32febdcca4a5137075c83cfbd7f3188208');
});

it('rejects reviewer mutation tools before reading or writing any authority binding', async () => {
  const scope = { job: { kind: 'agent', payload: { review_only: true, comparison_review: true,
    execution: { comparison_role: 'reviewer', comparison_approval_id: 'approval' },
    comparison_manifest: { version: 1, approval_id: 'approval', manifest_digest: 'a'.repeat(64) },
  } } } as unknown as Scope;
  const env = new Proxy({}, { get() { throw new Error('Unexpected authority access'); } }) as any;
  for (const name of ['context_publish', 'execution_complete', 'artifact_publish', 'delegate_agent', 'repair_team', 'refresh_candidate', 'peer_message']) {
    const result = await hostedMcp(env, scope, { name, arguments: {} });
    expect(result.status).toBe(403);
  }
});

it('never gives a review-only harness a writable fork or generic source Git capability', () => {
  const scope = { fork: 'namespace/claimed-fork', job: { kind: 'agent', payload: {
    workspace_transport: 'git-native-v1', review_only: true, comparison_review: true,
    execution: { base: { repository: 'namespace/base' } },
    team_inputs: [{ revision: { repository: 'namespace/other-builder' } }],
  } } } as unknown as Scope;
  for (const role of ['fork', 'canonical', 'team-0', 'target']) expect(gitRole(scope, role)).toBeNull();
});
