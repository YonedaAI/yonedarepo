import { readRun, workspaceAllowance } from '../reviewer-client.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { profile, starterFiles, protectedBundle, digest } from './profile.mjs';
import { checkedStep, readHistoryEvidence, readCheckReport } from './evidence.mjs';

const fail = (message) => {
  throw new Error(message);
};
const done = new Set(['ready', 'accepted', 'failed', 'cancelled']);
const sessionPath = (repo) => `repos/${repo}/guided_session`;
const provisional = (state) =>
  /^guide-session:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    state.session_id ?? '',
  ) &&
  !state.initial_commit &&
  ['requests', 'observed_runs', 'steps', 'history', 'check_reports'].every(
    (key) => !Object.keys(state[key] ?? {}).length,
  );
function adoptId(state, id) {
  if (
    !/^guide-session:[a-f0-9]{40}$/.test(id ?? '') ||
    (state.session_id && state.session_id !== id && !provisional(state))
  )
    fail('Guided session differs from retained session');
  state.session_id = id;
}

function sessionGuard(session, state) {
  if (
    session?.profile_id !== profile.id ||
    session.version !== profile.version ||
    typeof session.session_id !== 'string' ||
    !session.session_id ||
    !Array.isArray(session.steps) ||
    (state.session_id && state.session_id !== session.session_id)
  )
    fail('Guided session differs from retained session');
  const ids = session.steps.map((step) => step.id);
  if (!equal(ids, ['build', 'extend', 'concurrent', 'review'])) fail('Guided step order changed');
  return session;
}

/** These are server-read deployment facts, never CLI/model assertions authorizing transport. */
export function activationGuard(session) {
  if (session.source_transport !== 'api-source-v1' || session.source_allowlisted !== true)
    fail('Server must confirm this exact project is allowlisted for source API before paid work');
}

async function allowanceGuard(api) {
  const allowance = await workspaceAllowance(api);
  if (
    allowance?.version < 1 ||
    allowance?.limit_microusd !== 50_000_000 ||
    allowance.remaining_microusd <= 0
  )
    fail(
      'Existing active $50 workspace allowance required; this driver never activates or resets funding',
    );
  return allowance;
}

async function platformGuard(client, expected) {
  const health = await client.health();
  if (health.service !== 'yonedarepo' || health.revision !== expected)
    fail('Deployed revision differs from approved revision');
}

function sourceGuard(snapshot, source) {
  if (
    snapshot.repository?.status !== 'ready' ||
    snapshot.repository.pending != null ||
    snapshot.repository.head_commit !== snapshot.repository.published_commit ||
    snapshot.runs?.length ||
    snapshot.candidates?.length ||
    snapshot.jobs?.some((job) => ['queued', 'running'].includes(job.status))
  )
    fail('Fresh ready project without previous agent results required');
  const sorted = Object.fromEntries(
    Object.entries(source.files ?? {}).sort(([a], [b]) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    ),
  );
  if (
    source.revision?.commit !== snapshot.repository.published_commit ||
    !equal(sorted, starterFiles())
  )
    fail('Actual frozen starter bytes/allowlist differ from the unfinished profile');
}

async function collectRuns(api, repo, step, state, save) {
  const evidence = [];
  for (const id of step.run_ids) {
    const detail = await readRun(api, repo, id);
    const run = detail.runs[0];
    if (run.guided?.session_id !== state.session_id || run.guided.profile_id !== profile.id)
      fail('Run was not frozen to this guided session');
    const phase = step.id === 'concurrent' ? 'parallel' : step.id;
    if (run.guided.check_phase !== phase) fail('Run phase differs from protected phase');
    evidence.push({
      id,
      status: run.status,
      guided: run.guided,
      base: run.base,
      checked_working_revision: run.checked_working_revision,
      candidates: detail.candidates,
      evaluations: detail.evaluations,
      decisions: detail.decisions,
      team_tasks: detail.team_tasks,
      team_handoffs: detail.team_handoffs,
      executions: detail.executions?.map(({ id, strategy, provider, model, status, job_id }) => ({
        id,
        strategy,
        provider,
        model,
        status,
        job_id,
      })),
    });
  }
  if (step.id === 'concurrent') {
    const parallel = evidence.filter((item) => item.guided.check_phase === 'parallel');
    if (
      parallel.length !== 2 ||
      new Set(parallel.map((item) => item.guided.variant)).size !== 2 ||
      !parallel.every((item) => ['filter', 'sort'].includes(item.guided.variant)) ||
      !equal(parallel[0].base, parallel[1].base)
    )
      fail('Two distinct same-base filter/sort runs required');
  }
  state.observed_runs[step.id] = evidence;
  await save(state);
  return evidence;
}

/** All mutations require run:true. Mocks must identify themselves as offline protocol fixtures. */
export async function driveGuided(client, state, options = {}) {
  const {
    run = false,
    expectedRevision,
    save = async () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    waitMs = 1200000,
  } = options;
  if (!/^[a-f0-9]{7,64}$/.test(expectedRevision ?? ''))
    fail('An exact approved platform revision is required');
  if (state.profile_id && state.profile_id !== profile.id) fail('Retained profile differs');
  await platformGuard(client, expectedRevision);
  await allowanceGuard(client.api);
  if (!run) {
    if (!state.repo_id)
      return {
        mode: 'read_only',
        message:
          'No retained guided session; --run is required to create a fresh project or start work',
      };
    const session = sessionGuard(
      await client.api(sessionPath(state.repo_id)),
      provisional(state) ? { ...state, session_id: undefined } : state,
    );
    return { mode: 'read_only', repo_id: state.repo_id, session };
  }
  state.version ??= 1;
  state.profile_id = profile.id;
  state.evidence_kind =
    client.simulated === true ? 'offline_protocol_fixture' : 'actual_server_readback';
  state.exercise = 'planned same-base concurrent enhancements';
  state.context_causal_effect = null;
  state.source_digest ??= digest(starterFiles());
  state.test_bundle_digest ??= protectedBundle().digest;
  if (
    state.source_digest !== digest(starterFiles()) ||
    state.test_bundle_digest !== protectedBundle().digest
  )
    fail('Fixture or immutable oracle changed since retained session');
  state.requests ??= {};
  state.observed_runs ??= {};
  state.project_request_id ??= randomUUID();
  await save(state); // Persist stable identity before any ambiguous write.
  if (!state.repo_id) {
    await platformGuard(client, expectedRevision);
    const project = await client.api('projects', {
      request_id: state.project_request_id,
      name: 'Guided task board',
      guided_profile_id: profile.id,
    });
    if (typeof project.id !== 'string' || !/^repo-[a-f0-9]{32}$/.test(project.id))
      fail('Fresh project identity invalid');
    state.repo_id = project.id;
    if (project.guided_session_id !== undefined) adoptId(state, project.guided_session_id);
    await save(state);
  }
  const repo = state.repo_id;
  const deadline = now() + waitMs;
  let snapshot;
  for (;;) {
    const project = await client.api(`projects/${repo}`);
    if (project.status === 'ready') {
      snapshot = await client.api(`repos/${repo}/snapshot`);
      break;
    }
    if (project.status === 'failed' || now() >= deadline)
      fail('Fresh setup not ready; retained project must be inspected');
    await sleep(2000);
  }
  let session = sessionGuard(
    await client.api(sessionPath(repo)),
    provisional(state) ? { ...state, session_id: undefined } : state,
  );
  adoptId(state, session.session_id);
  await save(state);
  activationGuard(session);
  if (!state.initial_commit) {
    sourceGuard(snapshot, await client.api(`repos/${repo}/published_source`));
    state.initial_commit = snapshot.repository.published_commit;
    await save(state);
  }
  if (snapshot.repository.policy?.build?.test_bundle?.digest !== state.test_bundle_digest)
    fail('Server protected bundle is not the approved immutable oracle');
  for (const id of ['build', 'extend', 'concurrent']) {
    let step = session.steps.find((step) => step.id === id);
    if (step.status === 'needs_attention')
      fail('Guided step needs inspection; no new run or budget reset');
    if (step.status === 'locked') fail('Previous guided evidence has not unlocked this step');
    if (step.status === 'ready') {
      await platformGuard(client, expectedRevision);
      await allowanceGuard(client.api);
      activationGuard(session);
      const current = await client.api(`repos/${repo}/repository_overview`);
      if (current.repository?.published_commit !== state.initial_commit)
        fail('Canonical publication changed during this private exercise');
      state.requests[id] ??= {
        request_id: randomUUID(),
        session_id: state.session_id,
        profile_id: profile.id,
        step_id: id,
        expected_commit: session.working_revision?.commit ?? current.repository.head_commit,
        expected_version: session.working_version ?? current.repository.version,
      };
      await save(state);
      try {
        session = sessionGuard(
          await client.api(`repos/${repo}/start_guided_step`, state.requests[id]),
          state,
        );
      } catch (failure) {
        // Read the exact retained session after lost acknowledgement; never rotate IDs.
        session = sessionGuard(await client.api(sessionPath(repo, state)), state);
        if (session.steps.find((step) => step.id === id)?.status === 'ready') throw failure;
      }
      step = session.steps.find((step) => step.id === id);
    }
    while (step.status === 'running') {
      if (now() >= deadline) fail('Wait bound reached; resume only this retained session');
      await collectRuns(client.api, repo, step, state, save);
      await sleep(2000);
      session = sessionGuard(await client.api(sessionPath(repo, state)), state);
      step = session.steps.find((step) => step.id === id);
    }
    if (step.status !== 'complete') fail('Guided step has no complete authoritative evidence');
    const runs = await collectRuns(client.api, repo, step, state, save);
    if (!runs.length || runs.some((item) => !done.has(item.status)))
      fail('Completed step contains unfinished runs');
    const checked = checkedStep(step, runs);
    state.check_reports ??= {};
    state.check_reports[id] = await readCheckReport(client.api, repo, checked, id);
    state.history ??= {};
    for (const item of runs)
      state.history[item.id] ??= await readHistoryEvidence(client.api, repo, item.id);
    state.steps ??= {};
    state.steps[id] = { ...step, checked };
    await save(state);
  }
  return {
    mode: 'read_only_review',
    repo_id: repo,
    session_id: state.session_id,
    next_step: 'review',
    evidence_kind: state.evidence_kind,
    context_causal_effect: null,
    message:
      'Inspect authoritative result/checks/history; this driver does not publish or infer context causality',
  };
}
