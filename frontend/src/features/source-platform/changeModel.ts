// Change requests as the platform returns them (git_change_* in platform_tools.json), and the
// pure rules the change pages share: line anchors, thread grouping and the conversation order.
import type { CommitDetail } from './CommitGates';
import type { DiffChange, LineRow } from './DiffFiles';
import { patchRows } from './patchRows';

export const CHANGE_FILTERS = ['open', 'landed', 'closed', 'all'] as const;
export type ChangeFilter = (typeof CHANGE_FILTERS)[number];
export type ChangeStatus = Exclude<ChangeFilter, 'all'>;

export type Change = {
  number: number;
  title: string;
  body: string;
  branch: string;
  base: 'main';
  author: string;
  status: ChangeStatus;
  head: string | null;
  created_at: number;
  updated_at: number;
  landed_version: number | null;
  landed_commit: string | null;
  comment_count: number;
};

export type Side = 'old' | 'new';
export type ChangeComment = {
  id: number;
  commit: string;
  path: string | null;
  line: number | null;
  side: Side | null;
  body: string;
  principal: string;
  at: number;
  resolved_at: number | null;
};

export type Push = {
  version: number;
  action: 'created' | 'moved' | 'deleted';
  before: string | null;
  after: string | null;
  actor: string;
  at: number;
};

type DiffEnd = { commit: string; tree: string };

export type ChangeDetail = Change & {
  head_commit: CommitDetail | null;
  comments: ChangeComment[];
  timeline: Push[];
  /** From the merge base with main (null: unrelated histories) to the head, as git_diff answers. */
  diff: { base: DiffEnd | null; head: DiffEnd; changes: DiffChange[] } | null;
};

/** Where a comment on a line sits: deleted lines on the base file, others on the head file. */
export type Anchor = { commit: string; path: string; line: number; side: Side };

export const rowAnchor = (row: LineRow): { line: number; side: Side } =>
  row.kind === 'delete' ? { line: row.old ?? 0, side: 'old' } : { line: row.new ?? 0, side: 'new' };

export const anchorKey = (a: { path: string; line: number; side: Side }) =>
  `${a.side}:${a.line}:${a.path}`;

/** Every line anchor the diff shows, so threads off the diff can be listed apart. */
export function diffAnchors(changes: DiffChange[]): Set<string> {
  const keys = new Set<string>();
  for (const change of changes) {
    if (!change.patch) continue;
    for (const row of patchRows(change.patch))
      if (row.kind !== 'hunk' && row.kind !== 'note')
        keys.add(anchorKey({ path: change.path, ...rowAnchor(row) }));
  }
  return keys;
}

export type Thread = { anchor: Anchor; comments: ChangeComment[]; resolved: boolean };

/**
 * Splits comments into the general conversation, threads shown on the current diff (by anchor
 * key) and outdated threads: made on an earlier head, or on a line the diff no longer shows.
 */
export function groupComments(comments: ChangeComment[], head: string | null, shown: Set<string>) {
  const general: ChangeComment[] = [];
  const threads = new Map<string, Thread>();
  for (const c of comments) {
    if (c.path === null || c.line === null || c.side === null) {
      general.push(c);
      continue;
    }
    const anchor: Anchor = { commit: c.commit, path: c.path, line: c.line, side: c.side };
    const key = `${c.commit}|${anchorKey(anchor)}`;
    const thread = threads.get(key) ?? { anchor, comments: [], resolved: true };
    thread.comments.push(c);
    thread.resolved &&= c.resolved_at !== null;
    threads.set(key, thread);
  }
  const inline = new Map<string, Thread>();
  const outdated: Thread[] = [];
  for (const thread of threads.values()) {
    const key = anchorKey(thread.anchor);
    if (thread.anchor.commit === head && shown.has(key)) inline.set(key, thread);
    else outdated.push(thread);
  }
  return { general, inline, outdated };
}

export type ConversationItem =
  | { kind: 'comment'; at: number; comment: ChangeComment }
  | { kind: 'push'; at: number; push: Push };

/** General comments and branch pushes, oldest first (the timeline arrives newest first). */
export function conversation(general: ChangeComment[], timeline: Push[]): ConversationItem[] {
  return [
    ...general.map((comment) => ({ kind: 'comment' as const, at: comment.at, comment })),
    ...timeline.map((push) => ({ kind: 'push' as const, at: push.at, push })),
  ].sort((a, b) => a.at - b.at);
}

/** A principal for display: `user:ada` reads as `ada`. */
export const who = (principal: string) => principal.replace(/^user:/, '');

export const changesPath = (repo: string, filter: ChangeFilter) =>
  `/repos/${repo}/changes?status=${filter}&limit=100`;
