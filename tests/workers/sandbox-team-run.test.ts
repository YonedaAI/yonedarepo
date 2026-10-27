// A sandbox team run through the real ledger and platform in workerd. Member sandboxes are
// fakes (a container cannot run here); what each pushes is a real platform commit on its
// attempt branch. The trusted side lands every member on the team branch with the platform's
// land operation, the configured path a concurrent landing takes (the branch's queue and
// combiner once it moved), and the team branch head becomes the run's only candidate.
import { env, exports } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import {
  agentEgress,
  type SandboxAttempt,
  sandboxName,
} from '../../cloudflare/worker/sandbox-attempt';
import { landOnTeam, teamPort } from '../../cloudflare/worker/sandbox-team';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { platformCommit, platformProject } from './platform-fixture';

const bindings = env as unknown as Env;
afterEach(reset);

type Queue = {
  dispatchOneForTest(envelope: Envelope, loseAck: boolean): Promise<{ acked: boolean }>;
};
type Fake = { begun(): Promise<{ attempt: SandboxAttempt; count: number }> };
const queue = () => bindings.SELF as unknown as Queue;
// The ledger side of the port: the sandbox host is never used for a report.
const report = (attempt: SandboxAttempt) => teamPort(bindings, attempt, {} as any).reportLanding;

// The plan's write scopes stay disjoint (the plan format requires it); a sandbox does not
// enforce them, so two members can still write one file.
const task = (id: string, path: string) => ({
  id,
  title: `Task ${id}`,
  instructions: `Write ${path}`,
  agent: 0,
  depends_on: [],
  write_paths: [`scopes/${id}`],
});

/** Starts a two-task team run and dispatches both members; returns their attempts. */
async function teamRun(owner: string, run: string, paths: [string, string]) {
  const repo = `${owner.replace('_', '-')}-project`;
  const { base, platform } = await platformProject(bindings, owner, repo);
  const started = await ledger(bindings, repo, {
    op: 'start_run',
    id: run,
    intent: 'Add two notes',
    mode: 'collaborate',
    team: {
      version: 1,
      contract: 'Each task writes its own note',
      integrator_agent: 0,
      integration_paths: ['notes/'],
      tasks: [task('one', paths[0]), task('two', paths[1])],
    },
    workspace_transport: 'sandbox-cli-v1',
    _source_transport_approved: true,
    _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Builder' }],
  });
  expect(started).toMatchObject({ runtime: 'sandbox-cli-v1', mode: 'collaborate' });
  const attempts: SandboxAttempt[] = [];
  for (const n of [1, 2]) {
    const envelope: Envelope = { v: 1, kind: 'agent', repo_id: repo, job_id: `job:${run}:agent-${n}` };
    expect(await queue().dispatchOneForTest(envelope, false)).toMatchObject({ acked: true });
    const fake = (bindings.AGENT_SANDBOX as any).getByName(
      sandboxName(repo, `${run}:agent-${n}`),
    ) as Fake;
    attempts.push((await fake.begun()).attempt);
  }
  return { repo, base, attempts, platform };
}

/** What a member's `git push` leaves on the platform: one commit on the base, on its branch. */
async function push(platform: any, attempt: SandboxAttempt, files: Record<string, string>) {
  const pushed = await platformCommit(platform, attempt.base.commit, files);
  await platform.call('POST', '/branches', { ref: attempt.branch, commit: pushed.commit, expected: null });
  return pushed.commit;
}

async function captureTeam(repo: string, run: string) {
  const envelope: Envelope = { v: 1, kind: 'capture', repo_id: repo, job_id: `capture:${run}:team` };
  expect(await queue().dispatchOneForTest(envelope, false)).toMatchObject({ acked: true });
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  return snapshot.candidates.find((c: any) => c.run_id === run);
}

it('lands two disjoint members through the platform merge; the team branch is the candidate', async () => {
  const { repo, base, attempts, platform } = await teamRun('team_disjoint', 'team-run', [
    'notes/one.md',
    'notes/two.md',
  ]);
  const [first, second] = attempts;
  expect(first).toMatchObject({ branch: 'attempts/team-run/1', team: { branch: 'attempts/team-run/team' } });
  expect(first.prompt).toContain('Your task: Task one\nWrite notes/one.md');
  expect(first.prompt).toContain('Other agents work on the other tasks in parallel on the same base.');
  // The trusted side created the team branch at the frozen base (a landing, so the log can
  // prove later landings independent) before any sandbox started.
  const refs = async () => (await platform.call('GET', '/refs')).refs;
  expect((await refs())['refs/heads/attempts/team-run/team']).toBe(base.commit);

  const one = await push(platform, first, { 'notes/one.md': 'one\n' });
  const two = await push(platform, second, { 'notes/two.md': 'two\n' });
  const landedOne = await landOnTeam(bindings, first);
  expect(landedOne).toMatchObject({ landed: true, commit: one, teamCommit: one });
  // The second member's base moved under it: the branch's queue and combiner merge it.
  const landedTwo = await landOnTeam(bindings, second);
  expect(landedTwo).toMatchObject({ landed: true, commit: two });
  if (!landedTwo.landed) throw new Error('unreachable');
  expect(landedTwo.teamCommit).not.toBe(two);
  const head = (await refs())['refs/heads/attempts/team-run/team'];
  expect(head).toBe(landedTwo.teamCommit);
  const merged = await platform.call('GET', `/diff?base=${base.commit}&head=${head}`);
  expect(merged.changes.map((c: any) => c.path).sort()).toEqual(['notes/one.md', 'notes/two.md']);

  expect(await report(first)(landedOne, 0)).toEqual({ resume: false });
  // One member still works: no capture yet.
  await expect(
    ledger(bindings, repo, { op: 'job_status', id: 'capture:team-run:team' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await report(second)(landedTwo, 0);
  const candidate = await captureTeam(repo, 'team-run');
  expect(candidate).toMatchObject({
    execution: 'team-run:team',
    revision: { repository: base.repository, commit: head },
    status: 'evaluating',
    summary: 'Team branch: 2 of 2 tasks landed',
  });
});

it('resumes a conflicting member once; a second conflict fails it and what landed is the candidate', async () => {
  const { repo, base, attempts, platform } = await teamRun('team_conflict', 'clash-run', [
    'notes/same.md',
    'notes/same.md',
  ]);
  const [first, second] = attempts;
  const one = await push(platform, first, { 'notes/same.md': 'first line\n' });
  await push(platform, second, { 'notes/same.md': 'second line\n' });
  const landedOne = await landOnTeam(bindings, first);
  await report(first)(landedOne, 0);
  const clash = await landOnTeam(bindings, second);
  expect(clash).toEqual({ landed: false, paths: ['notes/same.md'] });
  expect(await report(second)(clash, 0)).toEqual({ resume: true });
  // The resumed agent stopped without merging the team branch: the landing conflicts again.
  const again = await landOnTeam(bindings, second);
  expect(again).toEqual({ landed: false, paths: ['notes/same.md'] });
  expect(await report(second)(again, 1)).toEqual({ resume: false });
  await ledger(bindings, repo, {
    op: 'fail',
    job_id: second.job_id,
    epoch: second.epoch,
    error: 'Conflicts with the team branch on notes/same.md after one resume',
    retryable: false,
  });
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  const member = snapshot.executions.find((e: any) => e.id === 'clash-run:agent-2');
  expect(member).toMatchObject({
    status: 'failed',
    landing: { status: 'conflict', paths: ['notes/same.md'], round: 1 },
  });
  const candidate = await captureTeam(repo, 'clash-run');
  expect(candidate).toMatchObject({
    revision: { repository: base.repository, commit: one },
    summary: 'Team branch: 1 of 2 tasks landed',
  });
});

it('member sandboxes can neither land nor push the team branch: only the trusted side lands', async () => {
  const { attempts, platform } = await teamRun('team_egress', 'egress-run', [
    'notes/one.md',
    'notes/two.md',
  ]);
  const [member] = attempts;
  const team = String(member.team?.branch);
  const commit = await push(platform, member, { 'notes/one.md': 'one\n' });
  // The member's own egress handler, exactly as its sandbox reaches the platform.
  const outbound = (exports as any).SandboxOutbound({ props: agentEgress(member) }) as Fetcher;
  const root = `${member.platform_origin}/api/v1/repos/${member.platform_repo}`;
  const post = (path: string, body: unknown) =>
    outbound.fetch(
      new Request(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  for (const ref of [team, member.branch])
    expect((await post('/land', { ref, commit })).status, `land ${ref}`).toBe(403);
  expect((await post('/branches', { ref: team, commit, expected: null })).status).toBe(403);
  const update = { ref: `refs/heads/${team}`, commit, expected: null };
  expect((await post('/refs/batch', { updates: [update] })).status).toBe(403);
  // Nothing moved the team branch: it is still at the frozen base.
  const refs = (await platform.call('GET', '/refs')).refs;
  expect(refs[`refs/heads/${team}`]).toBe(member.base.commit);
});
