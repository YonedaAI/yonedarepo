// A Landing on screen follows what happens to it. Agents report and CTC lands while nobody
// touches the page, so the gates, one cheap read, are asked again on CTC's beat while it is open;
// the page's heavy reads follow only when the gates answer differently.
import { useEffect, useMemo, useRef } from 'react';
import type { ChangeGates } from '../../../../shared/contracts/change-gates';
import { CTC_POLL_MS, visibleEvery } from './ctcModel';
import type { Loaded } from './useSource';

/** A listener for each answer, which calls `moved` when one differs from the one before it. */
export function saidChanged(moved: () => void) {
  let last: string | undefined;
  return (said: string | undefined) => {
    if (said === undefined) return;
    if (last !== undefined && said !== last) moved();
    last = said;
  };
}

export function useLandingWatch(open: boolean, gates: Loaded<ChangeGates>, moved: () => void) {
  const { reload } = gates;
  useEffect(() => {
    if (!open) return;
    return visibleEvery(CTC_POLL_MS, reload);
  }, [open, reload]);
  const latest = useRef(moved);
  latest.current = moved;
  const hear = useMemo(() => saidChanged(() => latest.current()), []);
  const said = gates.data && JSON.stringify(gates.data);
  useEffect(() => {
    hear(said);
  }, [hear, said]);
}
