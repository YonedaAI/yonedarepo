import { expect, it } from 'vitest';
import type { RunDetail, Snapshot } from '../../lib/types';
import { sessionFixture } from './guidedFixture';
import { guideEvidenceRun } from './guideEvidenceRun';

it('resolves the final checked candidate from its recorded concurrent runs instead of assuming latest wins', async () => {
  const session = sessionFixture();
  session.steps[2] = { ...session.steps[2], run_ids: ['first', 'latest'], candidate_id: 'final' };
  const snapshot = { repository: { id: 'repo' }, candidates: [] } as unknown as Snapshot;
  const paths: string[] = [];
  const load = async (path: string) => {
    paths.push(path);
    return {
      repository: { id: 'repo' },
      runs: [{ id: 'first' }],
      candidates: [{ id: 'final', run_id: 'first' }],
    } as unknown as RunDetail;
  };
  await expect(guideEvidenceRun(snapshot, session, 'final', load)).resolves.toBe('first');
  expect(paths).toEqual(['repos/repo/runs/first']);
});
it('rejects a foreign repository response rather than exposing its result', async () => {
  const session = sessionFixture();
  session.steps[2].run_ids = ['first'];
  session.steps[2].candidate_id = 'final';
  const snapshot = { repository: { id: 'repo' }, candidates: [] } as unknown as Snapshot;
  await expect(
    guideEvidenceRun(
      snapshot,
      session,
      'final',
      async () =>
        ({
          repository: { id: 'other' },
          runs: [{ id: 'first' }],
          candidates: [],
        }) as unknown as RunDetail,
    ),
  ).rejects.toThrow('different project');
});
