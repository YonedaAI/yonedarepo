import { expect, it } from 'vitest';
import { gitRole } from '../../cloudflare/worker/git-policy';
import type { Scope } from '../../cloudflare/worker/types';

const scope = (job: Record<string, any>, fork = 'ns/attempt') =>
  ({
    job: { ...job, payload: { workspace_transport: 'api-source-v1', ...job.payload } },
    fork,
  }) as Scope;

it('allows incremental source capture to upload only its assigned candidate fork', () => {
  const attempt = scope({ kind: 'capture', payload: {
    workspace_transport: 'api-source-v1', capture_subtype: 'source_changeset',
    base: { repository: 'ns/canonical' },
  } });
  expect(gitRole(attempt, 'candidate')).toEqual({ repository: 'ns/attempt', writable: true });
  for (const role of ['canonical', 'fork', 'target', 'team-0'])
    expect(gitRole(attempt, role)).toBeNull();
  expect(gitRole(scope({ ...attempt.job, kind: 'agent' }), 'candidate')).toBeNull();
  expect(gitRole(scope({ ...attempt.job, kind: 'evaluate' }), 'candidate')).toBeNull();
});

it('allows sparse refresh to preload only the frozen candidate and write only its assigned fork', () => {
  const attempt = scope({ kind: 'capture', payload: {
    workspace_transport: 'api-source-v1', capture_subtype: 'refresh_candidate',
    candidate: { revision: { repository: 'ns/frozen-candidate' } },
  } });
  expect(gitRole(attempt, 'fork')).toEqual({ repository: 'ns/attempt', writable: true });
  expect(gitRole(attempt, 'refresh-candidate')).toEqual({ repository: 'ns/frozen-candidate', writable: false });
  for (const role of ['current', 'head', 'canonical', 'candidate', 'target', 'team-0'])
    expect(gitRole(attempt, role)).toBeNull();
  expect(gitRole(scope({ ...attempt.job, kind: 'agent' }), 'fork')).toBeNull();
  expect(gitRole(scope({ ...attempt.job, kind: 'evaluate' }), 'refresh-candidate')).toBeNull();
});

it('never grants Git to agents, evaluators or captures without a frozen lazy-source job', () => {
  const resolver = scope({ kind: 'agent', payload: {
    execution: { base: { repository: 'ns/canonical' } },
    conflict_resolver: { merge_workspace_repository: 'ns/refresh' },
  } });
  for (const role of ['merge-workspace', 'canonical', 'fork', 'candidate'])
    expect(gitRole(resolver, role)).toBeNull();
  const legacy = scope({ kind: 'capture', payload: { workspace_transport: 'json-v1', capture_subtype: 'source_changeset' } });
  expect(gitRole(legacy, 'candidate')).toBeNull();
  const evaluator = scope({ kind: 'evaluate', payload: { capture_subtype: 'source_changeset' } });
  expect(gitRole(evaluator, 'candidate')).toBeNull();
});
