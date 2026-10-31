import { useCallback, useEffect, useRef, useState } from 'react';
import { type AccountPage, askAccount, type Outcome, pageOutcomes } from './searchAllModel';

/** A search of the account's repositories on the platform, as the page shows it. */
export type AccountSearch = {
  /** The platform has no such search: ask each repository. */
  off: boolean;
  outcomes: Outcome[];
  /** Names of the repositories in `outcomes`. */
  names: Map<string, string>;
  /** Repositories asked so far. */
  searched: number;
  loading: boolean;
  error?: string;
  next: string | null;
  /** Asks for the next page. */
  more: () => void;
  retry: () => void;
};

type Pages = { run: string; pages: AccountPage[]; loading: boolean; error?: string };

/** Learnt from a 404, once a session: every later search goes straight to the repositories. */
let unavailable = false;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Asks the platform for `query` (empty: nothing to ask), a page at a time. A new query cancels
 * what is in flight, and its answers replace the old ones at once, so none is ever shown under
 * the wrong query.
 */
export function useAccountSearch(query: string): AccountSearch {
  const [off, setOff] = useState(unavailable);
  const [tick, setTick] = useState(0);
  const run = `${tick}|${query}`;
  const [state, setState] = useState<Pages>({ run, pages: [], loading: Boolean(query) });
  const flight = useRef<AbortController | null>(null);

  const ask = useCallback((asked: string, id: string, after: string | null) => {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setState((s) => ({ run: id, pages: s.run === id ? s.pages : [], loading: true }));
    askAccount(asked, after, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        if (!page) {
          unavailable = true;
          setOff(true);
          return;
        }
        setState((s) => ({ run: id, pages: [...s.pages, page], loading: false }));
      },
      (e) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ run: id, pages: s.pages, loading: false, error: message(e) }));
      },
    );
  }, []);

  useEffect(() => {
    if (!query || off) return;
    ask(query, run, null);
    return () => flight.current?.abort();
  }, [query, run, off, ask]);

  const pages = state.run === run ? state.pages : [];
  const next = pages.at(-1)?.next ?? null;
  const more = useCallback(() => {
    if (next) ask(query, run, next);
  }, [ask, next, query, run]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  return {
    off,
    outcomes: pages.flatMap(pageOutcomes),
    names: new Map(pages.flatMap((p) => [...p.results, ...p.failed]).map((r) => [r.repo, r.name])),
    searched: pages.reduce((total, page) => total + page.searched, 0),
    loading: state.run === run ? state.loading : Boolean(query),
    error: state.run === run ? state.error : undefined,
    next,
    more,
    retry,
  };
}
