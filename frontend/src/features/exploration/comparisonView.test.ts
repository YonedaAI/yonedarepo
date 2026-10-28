import { expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { comparisonChoiceBlocker } from './comparisonView';
import { selectionBlocker } from './runReviewState';

const run = {
  id: 'compare',
  mode: 'compare',
  status: 'ready',
  working_branch_id: 'work',
  working_branch_version: 2,
  base: { repository: 'source', commit: 'base' },
  comparison: { version: 1, status: 'selected', selected_candidate_id: 'right' },
};
const candidates = ['left', 'right'].map((id) => ({
  id,
  run_id: run.id,
  execution: id,
  status: 'eligible',
  base: run.base,
  revision: { repository: 'source', commit: id },
  evaluation: `check-${id}`,
  paths: ['app.ts'],
}));
const snapshot = {
  repository: {
    id: 'repo',
    status: 'ready',
    head_commit: 'canonical',
    version: 4,
    policy: {
      version: 'policy',
      suite: 'commands-v1',
      environment: 'test',
      required_checks: ['behavior'],
    },
  },
  runs: [run],
  candidates,
  executions: candidates.map((c) => ({
    id: c.execution,
    run_id: run.id,
    role: 'coding',
    status: 'completed',
  })),
  evaluations: candidates.map((c) => ({
    id: c.evaluation,
    candidate: c.id,
    revision: c.revision,
    policy: 'policy',
    suite: 'commands-v1',
    environment: 'test',
    evidence: 'a'.repeat(64),
    checks: [{ name: 'behavior', status: 'pass' }],
  })),
  working_branches: [
    {
      id: 'work',
      status: 'active',
      version: 2,
      working_commit: 'right',
      working_revision: candidates[1].revision,
      canonical_base_commit: 'canonical',
      canonical_base_version: 4,
      latest_candidate_id: 'right',
    },
  ],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 1,
} as unknown as Snapshot;
it('allows choosing the eligible sibling in the screenshot while publication still requires the selected working head', () => {
  expect(selectionBlocker(snapshot, run, candidates[0])).toMatch(/Choose this checked result/);
  expect(comparisonChoiceBlocker(snapshot, run, candidates[0])).toBeUndefined();
  expect(selectionBlocker(snapshot, run, candidates[1])).toBeUndefined();
});
it('does not offer a sibling choice during agent activity, after a policy change, or for mismatched exact checks', () => {
  const variants = [
    {
      ...snapshot,
      executions: [
        ...snapshot.executions,
        { id: 'late', run_id: run.id, role: 'coding', status: 'running' },
      ],
    },
    {
      ...snapshot,
      repository: {
        ...snapshot.repository,
        policy: { ...snapshot.repository.policy, version: 'new-policy' },
      },
    },
    {
      ...snapshot,
      evaluations: snapshot.evaluations.map((e) => ({
        ...e,
        revision: { ...e.revision, commit: 'different' },
      })),
    },
    {
      ...snapshot,
      working_branches: snapshot.working_branches?.map((b) => ({
        ...b,
        canonical_base_version: 3,
      })),
    },
  ] as Snapshot[];
  for (const changed of variants)
    expect(comparisonChoiceBlocker(changed, run, candidates[1])).toBeTruthy();
});
it('allows manual choice before Compare has promoted its untouched frozen working base', () => {
  const untouched = {
    ...snapshot,
    working_branches: snapshot.working_branches?.map((b) => ({
      ...b,
      latest_candidate_id: null,
      working_commit: run.base.commit,
      working_revision: run.base,
    })),
  };
  expect(comparisonChoiceBlocker(untouched, run, candidates[0])).toBeUndefined();
  expect(comparisonChoiceBlocker(untouched, run, candidates[1])).toBeUndefined();
  const downstream = {
    ...untouched,
    working_branches: untouched.working_branches?.map((b) => ({
      ...b,
      latest_candidate_id: 'other-run',
      version: 3,
      working_commit: 'other',
      working_revision: { repository: 'source', commit: 'other' },
    })),
  };
  expect(comparisonChoiceBlocker(downstream, run, candidates[0])).toMatch(/branch/);
});
it('keeps a checked rejection out of selection and publication', () => {
  const rejected = { ...candidates[0], status: 'rejected' };
  const checkedFailure = {
    ...snapshot,
    evaluations: snapshot.evaluations.map((e) =>
      e.candidate === rejected.id ? { ...e, checks: [{ name: 'behavior', status: 'fail' }] } : e,
    ),
  };
  expect(comparisonChoiceBlocker(checkedFailure, run, rejected)).toMatch(/checks/);
  expect(selectionBlocker(checkedFailure, run, rejected)).toBeTruthy();
});
