// A sandbox run's candidate checked by a fresh check sandbox, through the real ledger, platform
// and evidence store in workerd: the evaluation claim starts one check sandbox (a fake Durable
// Object here), and the check driver, over a fake container, reports through the same
// `verify_finish` path the evaluator container uses.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { projectPlatform } from '../../cloudflare/worker/agents-platform';
import { recordSandboxCandidate, type SandboxAttempt, sandboxName } from '../../cloudflare/worker/sandbox-attempt';
import { checkName, checkPort, type SandboxHost } from '../../cloudflare/worker/sandbox-check';
import {
  type CheckAttempt,
  checkStep,
  initialCheckState,
} from '../../cloudflare/worker/sandbox-check-driver';
import type { OutboundProps } from '../../cloudflare/worker/sandbox-outbound';
import { checkScript, cloneScript, revisionScript } from '../../cloudflare/worker/sandbox-shell';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope, Json } from '../../cloudflare/worker/types';
import { platformCommit } from './platform-fixture';
import { api, readyReviewer } from './reviewer-fixture';

const bindings = env as unknown as Env;
afterEach(reset);

type Queue = {
  dispatchOneForTest(envelope: Envelope, loseAck: boolean): Promise<{ acked: boolean; launchRequested: boolean }>;
};
type Fake = {
  begun(): Promise<{ attempt: SandboxAttempt }>;
  checkBegun(): Promise<{ check: CheckAttempt; count: number }>;
};
const queue = () => bindings.SELF as unknown as Queue;

/** A sandbox run whose pushed commit is recorded as the candidate; returns the claimed check. */
async function candidateChecked(owner: string) {
  const fixture = await readyReviewer(owner);
  const repo = fixture.repo;
  const base = { repository: `platform/${repo}`, commit: fixture.head, tree: fixture.tree };
  await ledger(bindings, repo, {
    op: 'start_run',
    id: 'checked-run',
    intent: 'Add a trail',
    workspace_transport: 'sandbox-cli-v1',
    _source_transport_approved: true,
    _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Sandbox checks' }],
  });
  await queue().dispatchOneForTest({ v: 1, kind: 'agent', repo_id: repo, job_id: 'job:checked-run:agent-1' }, false);
  const agent = (bindings.AGENT_SANDBOX as any).getByName(sandboxName(repo, 'checked-run:agent-1')) as Fake;
  const { attempt } = await agent.begun();
  const platform = await projectPlatform(bindings, owner, repo);
  const pushed = await platformCommit(platform, base.commit, { 'public/extra.txt': 'trail\n' });
  await platform.call('POST', '/branches', { ref: attempt.branch, commit: pushed.commit, expected: null });
  await recordSandboxCandidate(bindings, attempt, 'Added a trail');
  const candidate = (await ledger(bindings, repo, { op: 'snapshot' })).candidates.find(
    (c: Json) => c.run_id === 'checked-run',
  );
  const jobId = `evaluate:${candidate.id}`;
  const envelope: Envelope = { v: 1, kind: 'evaluate', repo_id: repo, job_id: jobId };
  // The evaluation starts a check sandbox, never the evaluator container; a duplicate delivery
  // starts nothing more.
  expect(await queue().dispatchOneForTest(envelope, false)).toMatchObject({ acked: true, launchRequested: false });
  expect(await queue().dispatchOneForTest(envelope, false)).toMatchObject({ acked: true, launchRequested: false });
  const sandbox = (bindings.AGENT_SANDBOX as any).getByName(checkName(repo, jobId, 1)) as Fake;
  const { check, count } = await sandbox.checkBegun();
  expect(count).toBe(1);
  return { ...fixture, repo, pushed, candidate, check, jobId };
}

/** A container that answers the check port's commands as a real checkout would. */
class FakeContainer implements SandboxHost {
  egress: OutboundProps[] = [];
  commands: string[][] = [];
  destroyed = false;
  constructor(private head: string, private tree: string) {}
  ensure = async (props: OutboundProps) => {
    this.egress.push(props);
  };
  run = async (command: string[]) => {
    this.commands.push(command);
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
    if (command[2] === cloneScript) return ok('');
    if (command[2] === revisionScript) return ok(`${this.head}\n${this.tree}\n`);
    if (command[2] === checkScript) return ok('exit 0 3 0\n');
    if (command[0] === 'node') return ok(JSON.stringify({ files: { 'index.html': { content: '<h1>Trails</h1>', executable: false } } }));
    return ok('ok\n'); // stdout and stderr tails
  };
  destroy = async () => {
    this.destroyed = true;
  };
}

async function drive(check: CheckAttempt, host: SandboxHost) {
  const port = checkPort(bindings, host, check);
  let state = initialCheckState(Date.now());
  for (let i = 0; i < 40 && state.phase !== 'done'; i++) state = (await checkStep(state, check, port)).state;
  return state;
}

it('runs every policy command on the exact candidate and records the report as the evaluation', async () => {
  const { repo, pushed, candidate, check, jobId, cookie } = await candidateChecked('check_pass');
  expect(check).toMatchObject({
    job_id: jobId,
    epoch: 1,
    platform_origin: 'https://platform.test',
    candidate: { id: candidate.id, commit: pushed.commit, tree: candidate.tree },
    static_dir: 'public',
  });
  const container = new FakeContainer(pushed.commit, candidate.tree);
  const state = await drive(check, container);
  expect(state.phase).toBe('done');
  // Read-only egress, the candidate commit checked out, every setup and check command run.
  expect(container.egress.every((props) => props.role === 'check')).toBe(true);
  const clone = container.commands.find((c) => c[2] === cloneScript) ?? [];
  expect(clone.slice(4, 7)).toEqual([check.platform_origin, check.platform_repo, pushed.commit]);
  const ran = container.commands.filter((c) => c[2] === checkScript).map((c) => c.slice(7));
  expect(ran).toEqual([...check.setup, ...check.checks].map((spec) => spec.argv));
  expect(container.destroyed).toBe(true);

  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  const checked = snapshot.candidates.find((c: Json) => c.id === candidate.id);
  expect(checked.status).toBe('eligible');
  const evaluation = snapshot.evaluations.find((e: Json) => e.candidate === candidate.id);
  expect(evaluation.revision.commit).toBe(pushed.commit);
  expect(evaluation.deployment).toMatchObject({ commit: pushed.commit });
  expect(evaluation.checks.every((c: Json) => c.status === 'pass')).toBe(true);
  // The evidence the run page shows: each command's exit and output.
  const response = await api(bindings, `/api/repos/${repo}/evidence?digest=${evaluation.evidence}`, cookie);
  expect(response.status).toBe(200);
  const report = JSON.parse((await response.json<Json>()).content);
  expect(report.commands[0].output).toMatchObject({ exit: 0, stdout: 'ok\n', stderr: 'ok\n' });
});

it('fails the evaluation closed when the checkout is not the candidate tree', async () => {
  const { repo, pushed, candidate, check, jobId } = await candidateChecked('check_tree');
  const container = new FakeContainer(pushed.commit, 'f'.repeat(40));
  await drive(check, container);
  expect(container.commands.some((c) => c[2] === checkScript)).toBe(false);
  const job = await ledger(bindings, repo, { op: 'job_status', id: jobId });
  expect(job.status).toBe('failed');
  expect(String(job.error)).toMatch(/^Check checkout differs from the candidate/);
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.candidates.find((c: Json) => c.id === candidate.id).status).not.toBe('eligible');
});
