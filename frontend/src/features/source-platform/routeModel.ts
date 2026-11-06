// A change's route as its timeline reads it (`GET /changes/:n/route`), and the pure rules:
// what goes on the timeline, in what order, and how totals and bytes read.
import type {
  ChangeRoute,
  RouteCheck,
  RouteCommit,
  RouteDeliveredItem,
  RouteDelivery,
  RouteSession,
  RouteTotals,
  RouteTruncated,
} from '../../../../shared/contracts/change-route';
import { type ConversationItem, conversation, type Push } from './changeModel';
import { byteSize } from './releaseModel';

export const changeRoutePath = (repo: string, number: number) =>
  `/repos/${repo}/changes/${number}/route`;

export type RouteItem =
  | Extract<ConversationItem, { kind: 'push' }>
  | { kind: 'commit'; at: number; commit: RouteCommit }
  | { kind: 'session'; at: number; session: RouteSession; delivered: RouteDelivery[] }
  | { kind: 'check'; at: number; check: RouteCheck };

/** What tells delivered items apart: a traffic warning is one Landing on one file. */
export const deliveredKey = (i: { type: string; id: number; label: string | null }) =>
  `${i.type}:${i.id}:${i.type === 'traffic' ? i.label : ''}`;

/** The items of `deliveries`, each once: memories first, then the rest as delivered. */
export function deliveredItems(deliveries: RouteDelivery[]): RouteDeliveredItem[] {
  const items = new Map<string, RouteDeliveredItem>();
  for (const item of deliveries.flatMap((d) => d.items)) items.set(deliveredKey(item), item);
  const all = [...items.values()];
  return [...all.filter((i) => i.type === 'memory'), ...all.filter((i) => i.type !== 'memory')];
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `2 memories and 1 other item delivered · 340 B`. */
export function deliveredLine(deliveries: RouteDelivery[]) {
  const items = deliveredItems(deliveries);
  const memories = items.filter((i) => i.type === 'memory').length;
  const others = items.length - memories;
  const what = [
    memories > 0 && counted(memories, 'memory', 'memories'),
    others > 0 && counted(others, memories > 0 ? 'other item' : 'item', 'other items'),
  ].filter(Boolean);
  const bytes = deliveries.reduce((sum, d) => sum + d.bytes, 0);
  return `${what.join(' and ') || 'Nothing'} delivered · ${byteSize(bytes)}`;
}

/** `12.0 KiB read · 40.0 KiB fetched`: tokens per session aren't recorded; null when the
 * record has no tally. */
export function sessionBytes(s: Pick<RouteSession, 'read_bytes' | 'fetched_bytes'>) {
  const parts = [
    s.read_bytes != null && `${byteSize(s.read_bytes)} read`,
    s.fetched_bytes != null && `${byteSize(s.fetched_bytes)} fetched`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The totals in one line. */
export function routeSummary(t: RouteTotals, sessions: readonly RouteSession[]) {
  const readsKnown = sessions.length > 0 && sessions.every((s) => s.read_bytes != null);
  return [
    counted(t.commits, 'commit', 'commits'),
    counted(t.sessions, 'session', 'sessions'),
    readsKnown && `${byteSize(t.read_bytes)} read`,
    `${counted(t.memories_delivered, 'memory', 'memories')} delivered`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What the server cut, for `Showing only the newest …`; null when nothing was. */
export function routeCut(truncated: RouteTruncated) {
  const names: (keyof RouteTruncated)[] = ['commits', 'sessions', 'deliveries', 'checks'];
  const cut = names.filter((name) => truncated[name]);
  return cut.length ? cut.join(', ') : null;
}

/**
 * The branch's pushes (which `conversation` orders, and which need no route) with the route's
 * commits, sessions and checks, oldest first; a commit stands before the push that brought
 * it. A coding session's deliveries go on its first record. Without a route: the pushes.
 */
export function routeTimeline(route: ChangeRoute | undefined, pushes: Push[]): RouteItem[] {
  const pushed = conversation([], pushes) as Extract<ConversationItem, { kind: 'push' }>[];
  if (!route) return pushed;
  const placed = new Set<string>();
  const sessions = [...route.sessions].reverse().map((session) => {
    const id = session.session_id;
    const first = id !== null && !placed.has(id);
    if (first) placed.add(id);
    const delivered = first ? route.deliveries.filter((d) => d.session_id === id) : [];
    return { kind: 'session' as const, at: session.at, session, delivered };
  });
  const items: RouteItem[] = [
    ...[...route.commits].reverse().map((commit) => ({
      kind: 'commit' as const,
      at: commit.at,
      commit,
    })),
    ...pushed,
    ...sessions,
    ...[...route.checks].reverse().map((check) => ({
      kind: 'check' as const,
      at: check.at,
      check,
    })),
  ];
  return items.sort((a, b) => a.at - b.at);
}
