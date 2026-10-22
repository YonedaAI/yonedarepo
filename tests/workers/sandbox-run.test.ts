// A sandbox-cli-v1 run through the real ledger and platform in workerd: the queue claim starts
// one sandbox (a fake Durable Object here, since a container cannot run in tests), and a commit
// pushed to the attempt branch becomes the run's candidate, evaluated on that exact commit.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { projectPlatform } from '../../cloudflare/worker/agents-platform';
import {
  recordSandboxCandidate,
  type SandboxAttempt,
  sandboxName,
} from '../../cloudflare/worker/sandbox-attempt';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { platformCommit } from './platform-fixture';
import { readyReviewer } from './reviewer-fixture';

const bindings = env as unknown as Env;
afterEach(reset);

type Queue = {
  dispatchOneForTest(
    envelope: Envelope,
    loseAck: boolean,
  ): Promise<{ acked: boolean; retries: number[]; launchRequested: boolean }>;
};
type Fake = { begun(): Promise<{ attempt: SandboxAttempt; count: number }> };

it('claims once, starts one sandbox and records the pushed commit as the candidate', async () => {
  const owner = 'sandbox_owner';
  const fixture = await readyReviewer(owner);
  const repo = fixture.repo;
  const base = { repository: `platform/${repo}`, commit: fixture.head, tree: fixture.tree };
  const run = await ledger(bindings, repo, {
    op: 'start_run',
    id: 'sandbox-run',
    intent: 'Add function add(a,b) in src/math.js with a test',
    criteria: ['node --test passes'],
    // What the start route approves for `runtime: "sandbox-cli-v1"`.
    workspace_transport: 'sandbox-cli-v1',
    _source_transport_approved: true,
    _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Sandbox smoke' }],
  });
  expect(run).toMatchObject({ runtime: 'sandbox-cli-v1', workspace_transport: 'api-source-v1' });

  const queue = bindings.SELF as unknown as Queue;
  const jobId = 'job:sandbox-run:agent-1';
  const envelope: Envelope = { v: 1, kind: 'agent', repo_id: repo, job_id: jobId };
  expect(await queue.dispatchOneForTest(envelope, false)).toMatchObject({ acked: true });
  // A duplicate delivery is acknowledged without a second sandbox.
  expect(await queue.dispatchOneForTest(envelope, false)).toMatchObject({ acked: true });

  const sandbox = (bindings.AGENT_SANDBOX as any).getByName(
    sandboxName(repo, 'sandbox-run:agent-1'),
  ) as Fake;
  const { attempt, count } = await sandbox.begun();
  expect(count).toBe(1);
  expect(attempt).toMatchObject({
    job_id: jobId,
    epoch: 1,
    branch: 'attempts/sandbox-run/1',
    harness: 'claude',
    provider: 'zai',
    model: 'glm-5.3-flash',
    effort: 'low',
    model_base: 'https://api.z.ai/api/anthropic',
    platform_origin: 'https://platform.test',
    owner,
    base: { repository: base.repository, commit: base.commit },
  });
  expect(attempt.prompt).toContain('Add function add(a,b)');
  expect(attempt.prompt).toContain('node --test passes');
  const job = await ledger(bindings, repo, { op: 'job_status', id: jobId });
  expect(job).toMatchObject({ status: 'running', epoch: 1 });

  // What the sandbox's `git push` leaves on the platform: one commit on the frozen base.
  const platform = await projectPlatform(bindings, owner, repo);
  const pushed = await platformCommit(platform, base.commit, {
    'src/math.js': 'export const add = (a, b) => a + b;\n',
  });
  await platform.call('POST', '/branches', {
    ref: 'attempts/sandbox-run/1',
    commit: pushed.commit,
    expected: null,
  });
  await recordSandboxCandidate(bindings, attempt, 'Added add(a,b)');

  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  const candidate = snapshot.candidates.find((c: any) => c.run_id === 'sandbox-run');
  expect(candidate).toMatchObject({
    revision: { repository: base.repository, commit: pushed.commit },
    status: 'evaluating',
    summary: 'Added add(a,b)',
  });
  const evaluator = await ledger(bindings, repo, {
    op: 'job_status',
    id: `evaluate:${candidate.id}`,
  });
  expect(evaluator).toMatchObject({ kind: 'evaluate', status: 'queued' });
  expect(await ledger(bindings, repo, { op: 'job_status', id: jobId })).toMatchObject({
    status: 'done',
  });
});

it('fails the attempt with the reason when its sandbox cannot start', async () => {
  const fixture = await readyReviewer('sandbox_codex');
  const repo = fixture.repo;
  await ledger(bindings, repo, {
    op: 'start_run',
    id: 'codex-run',
    intent: 'Add add(a,b)',
    workspace_transport: 'sandbox-cli-v1',
    _source_transport_approved: true,
    _source_base: { repository: `platform/${repo}`, commit: fixture.head, tree: fixture.tree },
    // Codex speaks another protocol; the sandbox runs Claude Code only.
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Unsupported CLI' }],
  });
  const queue = bindings.SELF as unknown as Queue;
  const jobId = 'job:codex-run:agent-1';
  expect(
    await queue.dispatchOneForTest({ v: 1, kind: 'agent', repo_id: repo, job_id: jobId }, false),
  ).toMatchObject({ acked: true, retries: [] });
  expect(await ledger(bindings, repo, { op: 'job_status', id: jobId })).toMatchObject({
    status: 'failed',
  });
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  const execution = snapshot.executions.find((e: any) => e.id === 'codex-run:agent-1');
  expect(execution).toMatchObject({ status: 'failed', error: 'Queue dispatch failed (SANDBOX_HARNESS)' });
});

it('refuses a pushed commit that is not one commit on the frozen base', async () => {
  const owner = 'sandbox_stacked';
  const fixture = await readyReviewer(owner);
  const repo = fixture.repo;
  const base = { repository: `platform/${repo}`, commit: fixture.head, tree: fixture.tree };
  await ledger(bindings, repo, {
    op: 'start_run',
    id: 'stacked-run',
    intent: 'Add add(a,b)',
    workspace_transport: 'sandbox-cli-v1',
    _source_transport_approved: true,
    _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Sandbox smoke' }],
  });
  const queue = bindings.SELF as unknown as Queue;
  await queue.dispatchOneForTest(
    { v: 1, kind: 'agent', repo_id: repo, job_id: 'job:stacked-run:agent-1' },
    false,
  );
  const sandbox = (bindings.AGENT_SANDBOX as any).getByName(
    sandboxName(repo, 'stacked-run:agent-1'),
  ) as Fake;
  const { attempt } = await sandbox.begun();
  const platform = await projectPlatform(bindings, owner, repo);
  const first = await platformCommit(platform, base.commit, { 'a.txt': 'a\n' });
  const second = await platformCommit(platform, first.commit, { 'b.txt': 'b\n' });
  await platform.call('POST', '/branches', {
    ref: 'attempts/stacked-run/1',
    commit: second.commit,
    expected: null,
  });
  await expect(recordSandboxCandidate(bindings, attempt, 'Two commits')).rejects.toMatchObject({
    code: 'INVALID_CAPTURE',
  });
});
