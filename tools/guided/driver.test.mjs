import assert from 'node:assert/strict';
import test from 'node:test';
import { driveGuided } from './driver.mjs';
import { starterFiles, protectedBundle } from './profile.mjs';
import { createHash } from 'node:crypto';

const revision = 'd'.repeat(40);
const rootCommit = 'a'.repeat(40);
const repo = 'repo-' + 'a'.repeat(32);
const assignedSession = `guide-session:${createHash('sha256')
  .update(repo + '\0task-board-v1')
  .digest('hex')
  .slice(0, 40)}`;
function fixture(overrides = {}) {
  const calls = [],
    writes = [],
    reports = new Map();
  const state = {};
  const repository = {
    status: 'ready',
    head_commit: rootCommit,
    published_commit: rootCommit,
    version: 1,
    policy: { build: { test_bundle: { digest: protectedBundle().digest } } },
  };
  const session = {
    version: 1,
    profile_id: 'task-board-v1',
    session_id: assignedSession,
    source_transport: 'api-source-v1',
    source_allowlisted: true,
    steps: ['build', 'extend', 'concurrent', 'review'].map((id, index) => ({
      id,
      status: index ? 'locked' : 'ready',
      run_ids: [],
      evidence: [],
    })),
    next_step: 'build',
  };
  const runs = new Map();
  const client = {
    simulated: true,
    health: async () => ({ service: 'yonedarepo', revision }),
    api: async (path, body) => {
      calls.push({ path, ...(body ? { body: structuredClone(body) } : {}) });
      if (body) writes.push({ path, body: structuredClone(body) });
      if (path === 'workspace/allowance')
        return { version: 1, limit_microusd: 50000000, remaining_microusd: 42000000 };
      if (path === 'projects') return { id: repo, guided_session_id: assignedSession };
      if (path === `projects/${repo}`) return { id: repo, status: 'ready' };
      if (path.endsWith('/snapshot')) return { repository, runs: [], candidates: [], jobs: [] };
      if (path.endsWith('/repository_overview')) return { repository };
      if (path.endsWith('/published_source'))
        return { revision: { commit: rootCommit }, files: starterFiles() };
      if (path.includes('/guided_session')) {
        // Real server derives its ID; caller query parameters do not assign authority.
        return structuredClone(session);
      }
      if (path.endsWith('/start_guided_step')) {
        const step = session.steps.find((step) => step.id === body.step_id);
        step.status = 'complete';
        step.run_ids = step.id === 'concurrent' ? ['filter-run', 'sort-run'] : [step.id + '-run'];
        const base = session.working_revision ?? { repository: 'fixture/repo', commit: rootCommit };
        step.revision = {
          repository: 'fixture/result',
          commit: (step.id === 'build' ? 'b' : step.id === 'extend' ? 'c' : 'e').repeat(40),
        };
        step.candidate_id = step.id + '-candidate';
        for (const [index, id] of step.run_ids.entries()) {
          const report = {
            guided_check_phase: step.id === 'concurrent' ? 'final' : step.id,
            guided_check_variant: null,
          };
          const content = JSON.stringify(report),
            evidence = createHash('sha256').update(content).digest('hex');
          reports.set(evidence, { digest: evidence, content });
          runs.set(id, {
            repository,
            runs: [
              {
                id,
                status: 'ready',
                base,
                guided: {
                  version: 1,
                  profile_id: session.profile_id,
                  session_id: session.session_id,
                  check_phase: step.id === 'concurrent' ? 'parallel' : step.id,
                  ...(step.id === 'concurrent' ? { variant: index ? 'sort' : 'filter' } : {}),
                },
              },
            ],
            candidates: [
              {
                id: step.candidate_id,
                evaluation: step.id + '-evaluation',
                status: 'eligible',
                revision: step.revision,
              },
            ],
            evaluations: [
              {
                id: step.id + '-evaluation',
                candidate: step.candidate_id,
                revision: step.revision,
                evidence,
                policy: 'task-board-v1',
                suite: 'commands-v1',
                environment: 'linux-node24-rust1.94-v1',
                checks: [{ name: 'guided-task-board', status: 'pass' }],
              },
            ],
            executions: [],
            decisions: [],
            team_handoffs: [],
          });
        }
        session.working_revision = step.revision;
        session.working_version = (session.working_version ?? 0) + 1;
        session.steps[session.steps.indexOf(step) + 1].status = 'ready';
        session.next_step = session.steps[session.steps.indexOf(step) + 1].id;
        if (overrides.loseAck && step.id === 'build')
          throw new Error('Simulated lost acknowledgement');
        return structuredClone(session);
      }
      if (path.includes('/run_detail?')) {
        const id = new URL('https://fixture/' + path).searchParams.get('run_id');
        return overrides.run?.(structuredClone(runs.get(id)), id) ?? structuredClone(runs.get(id));
      }
      if (path.includes('/context_usage?'))
        return (
          overrides.usage ?? {
            version: 1,
            run_id: new URL('https://fixture/' + path).searchParams.get('run_id'),
            citations: [],
            has_more: false,
            next_cursor: 0,
          }
        );
      if (path.includes('/evidence?')) {
        const evidence = new URL('https://fixture/' + path).searchParams.get('digest');
        return reports.get(evidence);
      }
      throw new Error('Unexpected fixture API path');
    },
  };
  return { client, state, calls, writes, session, repository };
}
const options = { run: true, expectedRevision: revision, sleep: async () => {} };

test('default and read-only resume never write/create/start/save work', async () => {
  const f = fixture();
  const saved = [];
  assert.equal(
    (
      await driveGuided(f.client, f.state, {
        expectedRevision: revision,
        save: (x) => saved.push(x),
      })
    ).mode,
    'read_only',
  );
  assert.deepEqual(f.writes, []);
  assert.deepEqual(saved, []);
  f.state.repo_id = repo;
  f.state.session_id = assignedSession;
  assert.equal(
    (await driveGuided(f.client, f.state, { expectedRevision: revision })).session.session_id,
    f.state.session_id,
  );
  assert.deepEqual(f.writes, []);
});

test('platform, allowance, actual source bytes/allowlist and oracle guard before any paid step', async () => {
  for (const kind of ['platform', 'allowance', 'activation', 'source', 'oracle']) {
    const f = fixture();
    const original = f.client.api;
    if (kind === 'platform')
      f.client.health = async () => ({ service: 'yonedarepo', revision: 'f'.repeat(40) });
    if (kind === 'activation') f.session.source_allowlisted = false;
    if (kind === 'oracle') f.repository.policy.build.test_bundle.digest = '0'.repeat(64);
    f.client.api = async (path, body) => {
      if (kind === 'allowance' && path === 'workspace/allowance')
        return { version: 1, limit_microusd: 60000000, remaining_microusd: 60000000 };
      if (kind === 'source' && path.endsWith('/published_source'))
        return { revision: { commit: rootCommit }, files: {} };
      return original(path, body);
    };
    await assert.rejects(driveGuided(f.client, f.state, options));
    assert.equal(f.writes.filter((call) => call.path.endsWith('/start_guided_step')).length, 0);
  }
});

test('fresh project persists server-assigned deterministic identity before any guided start', async () => {
  const f = fixture(),
    persisted = [];
  await driveGuided(f.client, f.state, {
    ...options,
    save: async (state) => persisted.push(structuredClone(state)),
  });
  assert.equal(f.state.session_id, assignedSession);
  const starts = f.writes.filter((call) => call.path.endsWith('/start_guided_step'));
  assert.ok(starts.every((call) => call.body.session_id === assignedSession));
  assert.ok(
    persisted.some(
      (state) =>
        state.repo_id === repo &&
        state.session_id === assignedSession &&
        !state.initial_commit &&
        !Object.keys(state.requests).length,
    ),
  );
});

test('only an untouched legacy provisional UUID can be replaced by server readback', async () => {
  const provisional = 'guide-session:11111111-2222-4333-8444-555555555555';
  const fresh = fixture();
  Object.assign(fresh.state, { repo_id: repo, session_id: provisional });
  await driveGuided(fresh.client, fresh.state, options);
  assert.equal(fresh.state.session_id, assignedSession);
  for (const retained of [
    { requests: { build: { request_id: 'already-sent' } } },
    { initial_commit: rootCommit },
    { observed_runs: { build: [] } },
  ]) {
    const f = fixture();
    Object.assign(f.state, { repo_id: repo, session_id: provisional, ...retained });
    await assert.rejects(driveGuided(f.client, f.state, options), /retained session/);
    assert.equal(f.state.session_id, provisional);
    assert.equal(f.writes.length, 0);
  }
});

test('lost acknowledgement resumes the exact session and checked working head without duplicate starts/publishing', async () => {
  const f = fixture({ loseAck: true });
  const persisted = [];
  const result = await driveGuided(f.client, f.state, {
    ...options,
    save: async (state) => persisted.push(structuredClone(state)),
  });
  assert.equal(result.evidence_kind, 'offline_protocol_fixture');
  assert.equal(result.context_causal_effect, null);
  assert.equal(result.next_step, 'review');
  const starts = f.writes.filter((call) => call.path.endsWith('/start_guided_step'));
  assert.equal(starts.length, 3);
  assert.ok(starts.every((call) => call.body.session_id === f.state.session_id));
  assert.equal(starts[1].body.expected_commit, 'b'.repeat(40));
  assert.equal(starts[2].body.expected_commit, 'c'.repeat(40));
  for (const start of starts)
    assert.ok(
      persisted.some(
        (state) =>
          JSON.stringify(state.requests[start.body.step_id]) === JSON.stringify(start.body),
      ),
    );
  assert.ok(
    f.writes.every((call) => call.path === 'projects' || call.path.endsWith('/start_guided_step')),
  );
  const count = f.writes.length;
  await driveGuided(f.client, f.state, options);
  assert.equal(f.writes.length, count);
});

test('a claimed complete step with a mismatched checked revision cannot advance the next paid step', async () => {
  const f = fixture({
    run: (detail) => {
      detail.evaluations[0].revision = { repository: 'other', commit: '0'.repeat(40) };
      return detail;
    },
  });
  await assert.rejects(driveGuided(f.client, f.state, options), /exact candidate revision/);
  assert.equal(f.writes.filter((call) => call.path.endsWith('/start_guided_step')).length, 1);
});

test('same-base exercise rejects two runs on different bases rather than reporting coordinated success', async () => {
  const f = fixture({
    run: (detail, id) => {
      if (id === 'sort-run') detail.runs[0].base.commit = '9'.repeat(40);
      return detail;
    },
  });
  await assert.rejects(driveGuided(f.client, f.state, options), /same-base/);
});

test('receipt paging from another run or a looping cursor never becomes context evidence', async () => {
  const f = fixture({ usage: { run_id: 'other-run', has_more: true, next_cursor: 0 } });
  await assert.rejects(driveGuided(f.client, f.state, options), /different run/);
  assert.equal(f.writes.filter((call) => call.path.endsWith('/start_guided_step')).length, 1);
});
