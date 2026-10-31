// Follows an import from its repository's page. Nothing marks a repository as imported, so an
// empty one asks: a repository that was never imported has no import to read.
import { useEffect, useState } from 'react';
import { type ImportAnswer, importView, mayBeImport } from './importModel';
import type { RepoStatus } from './repoStatus';
import { sourceApi } from './sourceApi';

export const IMPORT_POLL_MS = 4000;
/** Reads that may fail in a row before the page says it has lost track. */
const STALLED_AFTER = 3;

export type ImportProgress =
  | { phase: 'none' }
  | { phase: 'checking' }
  | { phase: 'running'; stalled: boolean }
  | { phase: 'failed'; title: string; reason: string };

const NONE: ImportProgress = { phase: 'none' };

/** `onFinished` reads the repository again, which ends this: it has refs now. A finished
 * import whose repository still has none gets one more look, then its ordinary empty page. */
export function useImportProgress(
  repo: string,
  refs: RepoStatus['refs'] | undefined,
  onFinished: () => void,
): ImportProgress {
  const watching = mayBeImport(refs);
  const [progress, setProgress] = useState<ImportProgress>({ phase: 'checking' });
  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let answered = false;
    let finished = false;
    let misses = 0;
    const read = async () => {
      try {
        const answer = await sourceApi<ImportAnswer>(`/repos/${repo}/import`, {
          signal: controller.signal,
          once: true,
        });
        answered = true;
        misses = 0;
        const view = importView(answer);
        if (view.phase === 'failed') return setProgress(view);
        if (view.phase === 'complete') {
          if (finished) return setProgress(NONE);
          finished = true;
          onFinished();
        }
        setProgress({ phase: 'running', stalled: false });
      } catch {
        if (controller.signal.aborted) return;
        if (!answered) return setProgress(NONE);
        misses += 1;
        setProgress({ phase: 'running', stalled: misses >= STALLED_AFTER });
      }
      timer = setTimeout(read, IMPORT_POLL_MS);
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [repo, watching, onFinished]);
  return watching ? progress : NONE;
}
