// CTC's radar as its page reads it (`GET /ctc`): the words for what the server decided, and when
// to ask again. Nothing here decides anything: every state comes from the same decision the
// platform lands on.
import type {
  Decision,
  RadarDecision,
  RadarOverlap,
  RadarPlace,
} from '../../../../shared/contracts/ctc-radar';

export const ctcPath = (repo: string) => `/repos/${repo}/ctc`;

/** How often the page asks again: a decision takes a read per Landing, so not faster. */
export const CTC_POLL_MS = 15_000;

const STATES: Record<Decision, string> = {
  cleared: 'Cleared',
  hold: 'Hold',
  go_around: 'Go-around',
};

export const stateLabel = (decision: Decision | null) =>
  decision ? STATES[decision] : 'Not judged';

/** `1 · queued, ticket 12`; a Landing going around has no place. */
export function placeLine(place: RadarPlace | null) {
  if (!place) return '—';
  const ticket = place.ticket === null ? '' : `, ticket ${place.ticket}`;
  return `${place.position} · ${place.line}${ticket}`;
}

/** `same symbol: retry in src/net.rs`. */
export function overlapLine({ overlap, paths, symbols }: RadarOverlap) {
  const on = paths.join(', ');
  if (overlap === 'symbol') return `same symbol: ${symbols.join(', ')} in ${on}`;
  return overlap === 'file' ? `same file: ${on}` : `read conflict: ${on}`;
}

/** The newest decision on record, and whether it was about an older head. */
export function lastLine(last: RadarDecision) {
  const said = last.reason
    ? `${stateLabel(last.decision)}: ${last.reason}`
    : stateLabel(last.decision);
  return last.on_head ? said : `${said} (older head)`;
}

/** Calls `reload` every `ms` while `visible` says the page is on screen. Stops when called. */
export function visibleEvery(
  ms: number,
  reload: () => void,
  visible: () => boolean = () => document.visibilityState === 'visible',
) {
  const timer = setInterval(() => {
    if (visible()) reload();
  }, ms);
  return () => clearInterval(timer);
}
