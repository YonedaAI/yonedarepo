import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../frontend/src/lib/types';
import { reviewableCandidates, runAttention, selectionBlocker } from '../../frontend/src/features/exploration/runReviewState';

function fixture(): Snapshot {
  return {
    repository: { id: 'repo', name: 'Project', head_commit: 'base', published_commit: 'base', version: 1, status: 'ready', pending: null, policy: { suite: 'site', version: 'policy-v1', environment: 'test', required_checks: ['site'] }, remote: { namespace: 'test', name: 'repo' } },
    runs: [{ id: 'run', status: 'ready', mode: 'compare' }],
    executions: [{ id: 'agent', run_id: 'run', role: 'coding', status: 'completed' }],
    candidates: [{ id: 'result', run_id: 'run', execution: 'agent', status: 'eligible', base: { commit: 'base' }, revision: { commit: 'checked' }, evaluation: 'check' }],
    evaluations: [{ id: 'check', policy: 'policy-v1' }], decisions: [], artifacts: [], nodes: [], edges: [], seq: 1,
  };
}

describe('run attention and selection boundaries', () => {
  it('surfaces an independent checked result before less urgent agent failures', () => {
    const snapshot = fixture();
    snapshot.executions.push({ id: 'failed', run_id: 'run', status: 'failed' });
    const attention = runAttention(snapshot, snapshot.runs[0]);
    expect(attention).toMatchObject({ tone: 'review', action: 'review', candidate: { id: 'result' } });
    expect(attention.detail).toContain('1 agent attempt failed');
    expect(attention.detail).toContain('Nothing from this run has been published');
  });

  it('keeps comparison choice explicit when multiple results are reviewable', () => {
    const snapshot = fixture();
    snapshot.candidates.push({ ...snapshot.candidates[0], id: 'other' });
    expect(runAttention(snapshot, snapshot.runs[0])).toMatchObject({ action: 'review', actionLabel: 'Review approaches', candidate: undefined });
  });

  it.each(['head', 'policy', 'missing-policy', 'missing-evaluation', 'publication', 'cancelled', 'accepted', 'repository'])('withholds selection after %s changes', (change) => {
    const snapshot = fixture();
    if (change === 'head') snapshot.repository.head_commit = 'new-head';
    if (change === 'policy') snapshot.evaluations[0].policy = 'obsolete';
    if (change === 'missing-evaluation') snapshot.evaluations = [];
    if (change === 'missing-policy') snapshot.repository.policy = undefined;
    if (change === 'publication') snapshot.repository.pending = 'other-decision';
    if (change === 'cancelled' || change === 'accepted') snapshot.runs[0].status = change;
    if (change === 'repository') snapshot.repository.status = 'resync_required';
    expect(selectionBlocker(snapshot, snapshot.runs[0], snapshot.candidates[0])).toBeTruthy();
    expect(reviewableCandidates(snapshot, snapshot.runs[0])).toEqual([]);
    expect(runAttention(snapshot, snapshot.runs[0]).tone).not.toBe('review');
  });

  it.each(['publication_pending', 'publication_failed', 'published'])('prioritizes a recorded %s decision without a second publish action', (status) => {
    const snapshot = fixture();
    snapshot.decisions.push({ run_id: 'run', status, error: status === 'publication_failed' ? 'Git lease changed' : undefined });
    const attention = runAttention(snapshot, snapshot.runs[0]);
    expect(attention.action).toBe('details');
    expect(reviewableCandidates(snapshot, snapshot.runs[0])).toEqual([]);
    if (status === 'publication_failed') expect(attention.detail).toBe('Git lease changed');
    if (status === 'published') expect(attention.title).toBe('Published');
  });

  it('uses only the current team integration capture after retry', () => {
    const snapshot = fixture();
    snapshot.runs[0].mode = 'collaborate';
    snapshot.executions[0].team_role = 'integrator';
    snapshot.candidates.push({ ...snapshot.candidates[0], id: 'retry', status: 'evaluating' });
    snapshot.team_tasks = [{ run_id: 'run', role: 'integrator', execution_id: 'agent', candidate_id: 'retry' }];
    expect(reviewableCandidates(snapshot, snapshot.runs[0])).toEqual([]);
    expect(runAttention(snapshot, snapshot.runs[0])).toMatchObject({ title: 'Checks in progress', action: 'results' });
  });

  it('reveals failed work without implying parallel active work stopped', () => {
    const snapshot = fixture();
    snapshot.candidates = [];
    snapshot.runs[0].status = 'failed';
    snapshot.executions = [{ id: 'bad', run_id: 'run', status: 'failed' }, { id: 'active', run_id: 'run', status: 'running' }];
    expect(runAttention(snapshot, snapshot.runs[0])).toMatchObject({ tone: 'blocked', action: 'activity' });
    expect(runAttention(snapshot, snapshot.runs[0]).detail).toContain('Other work is still active');
  });

  it('surfaces older pending review without borrowing a later run’s decision', () => {
    const snapshot = fixture();
    const later = { id: 'later', status: 'accepted' };
    snapshot.runs.push(later);
    snapshot.decisions.push({ run_id: 'later', status: 'published' });
    expect(runAttention(snapshot, later).tone).toBe('published');
    expect(snapshot.runs.filter((run) => runAttention(snapshot, run).tone === 'review').map((run) => run.id)).toEqual(['run']);
  });

  it('does not promote a completed execution to a verified source result', () => {
    const snapshot = fixture();
    snapshot.candidates[0].status = 'evaluating';
    expect(runAttention(snapshot, snapshot.runs[0]).action).toBe('results');
    snapshot.candidates[0].status = 'rejected';
    expect(runAttention(snapshot, snapshot.runs[0]).title).toBe('Changes did not pass checks');
  });
});
