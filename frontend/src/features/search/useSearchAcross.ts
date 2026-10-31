import { useCallback, useEffect, useState } from 'react';
import { askRepository, fanOut, type Outcome } from './searchAllModel';

/**
 * Asks `targets` (null: not known yet) for `query` (empty: nothing to ask) and collects their
 * answers in arrival order. A new query or set of repositories cancels the requests in flight,
 * and its answers replace the old ones at once, so none is ever shown under the wrong query.
 */
export function useSearchAcross(query: string, targets: string[] | null) {
  const repos = targets?.join() ?? null;
  const [tick, setTick] = useState(0);
  const run = `${tick}|${repos}|${query}`;
  const [state, setState] = useState<{ run: string; outcomes: Outcome[] }>({ run, outcomes: [] });
  useEffect(() => {
    if (!query || repos === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    const asked = repos ? repos.split(',') : [];
    void fanOut(
      asked,
      async (repo) => {
        const outcome = await askRepository(repo, query, signal);
        if (!outcome) return;
        setState((s) => ({
          run,
          outcomes: s.run === run ? [...s.outcomes, outcome] : [outcome],
        }));
      },
      signal,
    );
    return () => controller.abort();
  }, [query, repos, run]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { outcomes: state.run === run ? state.outcomes : [], retry };
}
