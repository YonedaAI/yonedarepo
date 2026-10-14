import { useEffect, useState } from 'react';
import { mergeRunDetails, preferSnapshotRows } from '../../hooks/repositorySnapshot';
import { api } from '../../lib/api';
import type { RunDetail, Snapshot } from '../../lib/types';
/** A historical guide link reads exact current owner-scoped detail before mounting decision controls. */
export function useGuidedRun(snapshot: Snapshot, runId: string) {
  const [loaded, setLoaded] = useState<{
    repo: string;
    run: string;
    detail?: RunDetail;
    error?: string;
  }>();
  const repo = snapshot.repository.id;
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    void api<RunDetail>(
      `repos/${encodeURIComponent(repo)}/runs/${encodeURIComponent(runId)}`,
      undefined,
      { signal: controller.signal },
    )
      .then((detail) => {
        if (controller.signal.aborted) return;
        if (
          detail.repository.id !== repo ||
          detail.runs.length !== 1 ||
          detail.runs[0].id !== runId ||
          !Number.isSafeInteger(detail.seq) ||
          detail.seq < snapshot.seq
        )
          throw new Error('The requested run could not be verified in this project.');
        setLoaded({ repo, run: runId, detail });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoaded({ repo, run: runId, error: (error as Error).message });
      });
    return () => controller.abort();
  }, [repo, runId, snapshot.seq]);
  const current = loaded?.repo === repo && loaded.run === runId ? loaded : undefined;
  const detail = current?.detail;
  const fresh = !!detail && detail.seq >= snapshot.seq;
  // A live update makes the last verified detail older than the snapshot. Keep showing it while
  // the newer read is in flight, letting rows the snapshot already holds win, instead of
  // unmounting the run view behind a loading state on every resync.
  const view = detail
    ? fresh
      ? mergeRunDetails(snapshot, [detail], {
          repository: detail.repository,
          v: 1,
          counts: {},
          watermark: detail.seq,
          capabilities: detail.capabilities ?? snapshot.capabilities ?? {},
          working_branches: detail.working_branches ?? snapshot.working_branches,
        })
      : preferSnapshotRows(snapshot, detail)
    : snapshot;
  return {
    snapshot: view,
    /** Only the first read of a run blocks its view. */
    loading: !!runId && !detail && !current?.error,
    refreshing: !!runId && !!detail && !fresh && !current?.error,
    error: current?.error ?? '',
  };
}
