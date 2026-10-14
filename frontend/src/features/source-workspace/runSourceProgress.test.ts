import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { SourcePreparationJob } from '../../lib/sourceWorkspace';
import type { Snapshot } from '../../lib/types';
import { RunSourceProgress } from './RunSourceProgress';
import { runSourceProgress } from './sourceRunProgress';

const snapshot = {
  repository: {
    id: 'repo',
    status: 'ready',
    head_commit: 'base',
    pending: null,
    policy: { version: 'policy' },
  },
  runs: [],
  executions: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 0,
} as unknown as Snapshot;
const run = {
  id: 'run',
  workspace_transport: 'api-source-v1',
  status: 'exploring',
  model_requests: 0,
};
it('keeps old transport approvals unchanged and starts new source progress without granting review eligibility', () => {
  expect(runSourceProgress(snapshot, { ...run, workspace_transport: 'git-native-v1' })).toBeNull();
  expect(runSourceProgress(snapshot, run)).toMatchObject({
    stage: 'preparing',
    title: 'Preparing source',
  });
});
it('does not leave observed model work or captured checks behind an unending preparing label', () => {
  expect(runSourceProgress(snapshot, { ...run, model_requests: 1 })).toMatchObject({
    stage: 'working',
    title: 'Agent working',
  });
  expect(
    runSourceProgress({ ...snapshot, candidates: [{ id: 'c', run_id: 'run' }] }, run),
  ).toMatchObject({ stage: 'checking' });
});
it('requires the existing current-policy and branch guards for the human-review phase', () => {
  const candidate = {
    id: 'c',
    run_id: 'run',
    base: { commit: 'base' },
    status: 'eligible',
    evaluation: 'eval',
  };
  const checked = {
    ...snapshot,
    candidates: [candidate],
    evaluations: [{ id: 'eval', policy: 'policy' }],
  };
  expect(runSourceProgress(checked, { ...run, status: 'ready' })).toMatchObject({
    stage: 'review',
    title: 'Ready for human review',
  });
  expect(
    runSourceProgress(
      { ...checked, evaluations: [{ id: 'eval', policy: 'old' }] },
      { ...run, status: 'ready' },
    )?.title,
  ).toBe('Result needs attention');
});
it('makes cancellation and failure terminal progress rather than proposing a new run or waiting on source', () => {
  expect(runSourceProgress(snapshot, { ...run, status: 'cancelled' })).toMatchObject({
    stage: 'cancelled',
  });
  expect(runSourceProgress(snapshot, { ...run, status: 'failed' })).toMatchObject({
    stage: 'failed',
    error: true,
  });
});
const preparation = (
  job_id: string,
  status: SourcePreparationJob['status'],
  started: number | null = null,
): SourcePreparationJob => ({
  job_id,
  kind: 'agent',
  status,
  stage: 'source_preparing',
  epoch: 2,
  observed_at: 100,
  not_before: null,
  runtime_started_at: started,
});
it('shows all pending native preparations even after another agent has made model requests or produced a capture', () => {
  const state = {
    ...snapshot,
    runs: [run],
    source_preparation: [
      preparation('job-one', 'ready', 100),
      preparation('job-two', 'pending'),
      { ...preparation('evaluate', 'pending'), kind: 'evaluate' as const },
    ],
    candidates: [{ id: 'c', run_id: 'run' }],
  };
  expect(runSourceProgress(state, { ...run, model_requests: 8 })).toMatchObject({
    stage: 'preparing',
    title: 'Preparing source',
    preparing_jobs: 2,
  });
});
it('does not treat a ready marker as runtime start without its recorded start time or actual model work', () => {
  const state = { ...snapshot, runs: [run], source_preparation: [preparation('job', 'ready')] };
  expect(runSourceProgress(state, run)).toMatchObject({
    stage: 'waiting',
    title: 'Waiting for agents',
  });
  expect(
    runSourceProgress({ ...state, source_preparation: [preparation('job', 'ready', 100)] }, run),
  ).toMatchObject({ stage: 'working', title: 'Agent working' });
});
it('reports failed preparation alongside other in-flight jobs without claiming the whole run stopped', () => {
  const state = {
    ...snapshot,
    runs: [run],
    source_preparation: [
      preparation('job-one', 'pending'),
      preparation('job-two', 'failed'),
      preparation('job-three', 'ready', 100),
    ],
  };
  expect(runSourceProgress(state, run)).toMatchObject({
    stage: 'preparing',
    preparing_jobs: 1,
    failed_preparations: 1,
    error: true,
  });
  expect(
    runSourceProgress({ ...state, source_preparation: [preparation('job-two', 'failed')] }, run),
  ).toMatchObject({ stage: 'attention', title: 'Source preparation needs attention' });
});
it('keeps absent legacy metadata compatible and does not mislabel an empty factual marker list as preparation', () => {
  expect(runSourceProgress(snapshot, run)?.stage).toBe('preparing');
  expect(runSourceProgress({ ...snapshot, runs: [run], source_preparation: [] }, run)?.stage).toBe(
    'waiting',
  );
});
it('never borrows another run preparation when the repository snapshot contains several runs', () => {
  const state = {
    ...snapshot,
    runs: [run, { id: 'other' }],
    source_preparation: [
      { ...preparation('job-other', 'pending'), run_id: 'other' },
      { ...preparation('job-here', 'ready', 100), run_id: 'run' },
    ],
  };
  expect(runSourceProgress(state, run)).toMatchObject({ stage: 'working', preparing_jobs: 0 });
});
it('offers only a read-only status refresh while factual preparation is waiting, without starting work on render', () => {
  let requests = 0;
  const html = renderToStaticMarkup(
    createElement(RunSourceProgress, {
      snapshot: {
        ...snapshot,
        capabilities: { source_api: 1 },
        runs: [run],
        source_preparation: [],
      },
      run,
      onRefresh: async () => {
        requests++;
      },
    }),
  );
  expect(html).toContain('Waiting for agents');
  expect(html).toMatch(/<button\b[^>]*>\s*Refresh run status\s*<\/button>/);
  expect(html).not.toContain('Start a Run');
  expect(requests).toBe(0);
});
it('shows a recorded platform capture failure after model work instead of claiming an agent is still working', () => {
  const failed = {
    id: 'builder',
    run_id: run.id,
    role: 'coding',
    status: 'failed',
    failure_stage: 'capture',
    failure_job_id: 'capture:builder',
    failure_job_epoch: 3,
  };
  const state = { ...snapshot, runs: [run], executions: [failed] };
  expect(runSourceProgress(state, { ...run, status: 'ready', model_requests: 48 })).toMatchObject({
    stage: 'capture_failed',
    title: 'Capture failed',
    error: true,
  });
  expect(runSourceProgress(state, { ...run, status: 'failed', model_requests: 48 })?.title).toBe(
    'Capture failed',
  );
  const continuing = {
    ...state,
    executions: [failed, { id: 'peer', run_id: run.id, role: 'coding', status: 'running' }],
  };
  expect(runSourceProgress(continuing, { ...run, model_requests: 48 })?.title).toBe(
    'Agent working',
  );
  expect(runSourceProgress(state, { ...run, status: 'cancelled' })?.title).toBe('Run cancelled');
});
it('offers human choice for exact recovered eligible checks while retaining current policy and lease guards', async () => {
  const { comparisonFixture } = await import('../../../../tests/frontend/comparisonFixture');
  const fixture = comparisonFixture();
  const recovered = {
    ...fixture.run,
    workspace_transport: 'api-source-v1',
    comparison: {
      ...fixture.comparison,
      status: 'needs_attention',
      selected_candidate_id: null,
      reviewer_status: 'skipped',
      review_skip_reason: { code: 'CAPTURE_RECOVERY_CHECK_ONLY', authority: 'platform' },
      verification_recovery: {
        version: 1,
        automatic_review: false,
        request_id: 'recovery',
        authority: 'owner_verification_recovery',
      },
    },
  };
  expect(runSourceProgress(fixture.snapshot, recovered)).toMatchObject({
    stage: 'choice',
    title: 'Ready for human choice',
    error: false,
  });
  const policy = fixture.snapshot.repository.policy;
  if (!policy) throw new Error('The synthetic recovery fixture requires a policy.');
  const stale = {
    ...fixture.snapshot,
    repository: {
      ...fixture.snapshot.repository,
      policy: { ...policy, version: 'different' },
    },
  };
  expect(runSourceProgress(stale, recovered)?.title).toBe('Result needs attention');
});
