import { expect, it } from 'vitest';
import { gitRole } from '../../cloudflare/worker/git-policy';
import type { Scope } from '../../cloudflare/worker/types';

const scope = (job: Record<string, any>, fork = 'ns/attempt') =>
  ({
    job: { ...job, payload: { workspace_transport: 'git-native-v1', ...job.payload } },
    fork,
  }) as Scope;

it('fences refresh reads to frozen current, head, candidate and output fork repositories', () => {
  const attempt = scope({
    kind: 'capture',
    payload: {
      capture_subtype: 'refresh_candidate',
      candidate: {
        base: { repository: 'ns/canonical' },
        revision: { repository: 'ns/source', commit: 'c'.repeat(40) },
      },
    },
  });
  for (const role of ['current', 'head'])
    expect(gitRole(attempt, role)).toEqual({ repository: 'ns/canonical', writable: false });
  expect(gitRole(attempt, 'candidate')).toEqual({ repository: 'ns/source', writable: false });
  expect(gitRole(attempt, 'fork')).toEqual({ repository: 'ns/attempt', writable: true });
  expect(gitRole(attempt, 'canonical')).toBeNull();
  expect(gitRole(attempt, 'target')).toBeNull();
});

it('gives a resolver read access to its exact merge workspace and writes only its own fork', () => {
  const attempt = scope({
    kind: 'agent',
    payload: {
      execution: { base: { repository: 'ns/canonical' } },
      conflict_resolver: {
        merge_workspace_repository: 'ns/refresh',
        merge_workspace_commit: 'd'.repeat(40),
      },
    },
  });
  expect(gitRole(attempt, 'merge-workspace')).toEqual({ repository: 'ns/refresh', writable: false });
  expect(gitRole(attempt, 'canonical')).toEqual({ repository: 'ns/canonical', writable: false });
  expect(gitRole(attempt, 'fork')).toEqual({ repository: 'ns/attempt', writable: true });
  expect(gitRole(attempt, 'current')).toBeNull();
  expect(gitRole(attempt, 'team-0')).toBeNull();
});

it('gives trusted conflict capture read access to its frozen merge workspace only', () => {
  const attempt = scope({
    kind: 'capture',
    payload: {
      capture_subtype: 'resolve_conflict',
      execution: { base: { repository: 'ns/canonical' } },
      conflict_resolver: {
        merge_workspace_repository: 'ns/refresh',
        merge_workspace_commit: 'd'.repeat(40),
      },
    },
  });
  const mergeWorkspace = gitRole(attempt, 'merge-workspace');
  expect(mergeWorkspace).toEqual({ repository: 'ns/refresh', writable: false });
  expect(gitRole(attempt, 'canonical')).toEqual({ repository: 'ns/canonical', writable: false });
  expect(mergeWorkspace?.writable).toBe(false);
  expect(gitRole(attempt, 'target')).toBeNull();
  expect(gitRole(attempt, 'team-0')).toBeNull();
});
