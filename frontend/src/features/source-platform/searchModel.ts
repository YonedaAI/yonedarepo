// One search across a repository as the search API answers it (`git_grep`): files and
// lines, memories, and groups of commits, session records and change requests, each with a
// count. A record group is null when it was not asked for or the caller cannot read it.
import type { SourceRoute } from './sourceRoute';

/** A matching line; `ranges` are `[start, end)` in UTF-16 code units of `text`. */
export type CodeLine = { line: number; text: string; ranges?: [number, number][] };
/**
 * A file the code search found, ranked by `match` (a whole word, the path, then only inside
 * words), then `hits` (matches in the file, of which at most 20 lines are listed).
 */
export type CodeHit = {
  path: string;
  match?: 'word' | 'path' | 'substring';
  hits?: number;
  lines: CodeLine[];
};
export type Skipped = { path: string; reason: string };
/** A memory whose text holds the query's words. */
export type MemoryHit = {
  id: number;
  text: string;
  stale: boolean | null;
  memory: { kind: string };
};
export type CommitHit = {
  commit: string;
  subject: string;
  principal: string;
  recorded_at: number;
  matched: string[];
  paths: string[];
};
export type SessionHit = {
  id: number;
  commit: string;
  cli: string;
  model: string | null;
  session_id: string | null;
  summary: string;
  at: number;
  matched: string[];
  reads: string[];
};
export type ChangeHit = {
  number: number;
  title: string;
  status: string;
  branch: string;
  base: string;
  author: string;
  updated_at: number;
  matched: string[];
};
export type RecordGroup<T> = { count: number; capped: boolean; results: T[] };

export type SearchAnswer = {
  results: CodeHit[];
  skipped_files: Skipped[];
  skipped_count: number;
  memories?: MemoryHit[] | null;
  commits?: RecordGroup<CommitHit> | null;
  sessions?: RecordGroup<SessionHit> | null;
  changes?: RecordGroup<ChangeHit> | null;
};

/** The search API path for `query` (case-insensitive code search; whole words with `word`). */
export const searchPath = (repo: string, query: string, word = false) =>
  `/repos/${repo}/search?query=${encodeURIComponent(query)}&ignore_case=true${word ? '&word=true' : ''}`;

/** Lines a file shows before it is expanded. */
const COLLAPSED = 3;

/** `text` split at the matched ranges, each piece marked or not. */
export function highlight(
  text: string,
  ranges: CodeLine['ranges'],
): { text: string; mark: boolean }[] {
  const pieces: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges ?? []) {
    if (start < at || end <= start || end > text.length) continue;
    if (start > at) pieces.push({ text: text.slice(at, start), mark: false });
    pieces.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length || pieces.length === 0) pieces.push({ text: text.slice(at), mark: false });
  return pieces;
}

/** The lines a file shows, and how many of its matches they leave out. */
export function shownLines(hit: CodeHit, expanded: boolean) {
  const lines = expanded ? hit.lines : hit.lines.slice(0, COLLAPSED);
  const shown = lines.reduce((n, l) => n + Math.max(1, l.ranges?.length ?? 0), 0);
  return { lines, more: Math.max(0, (hit.hits ?? 0) - shown) };
}

/** One record result as the page lists it: where it links, its label and its detail. */
export type RecordRow = { key: string; route: SourceRoute; label: string; detail: string };
export type RecordSection = {
  key: 'commits' | 'sessions' | 'changes';
  title: string;
  count: string;
  rows: RecordRow[];
};

/** `12` or `1000+` (a group the platform stopped counting). */
const counted = (group: RecordGroup<unknown>) => `${group.count}${group.capped ? '+' : ''}`;

/** The record groups with any match, in the page's order. */
export function recordSections(repo: string, answer: SearchAnswer): RecordSection[] {
  const sections: RecordSection[] = [];
  if (answer.commits?.count)
    sections.push({
      key: 'commits',
      title: 'Commits',
      count: counted(answer.commits),
      rows: answer.commits.results.map((c) => ({
        key: c.commit,
        route: { view: 'commit', repo, commit: c.commit },
        label: `${c.commit.slice(0, 12)} ${c.subject}`,
        detail: [c.principal, ...c.paths].join(' · '),
      })),
    });
  if (answer.sessions?.count)
    sections.push({
      key: 'sessions',
      title: 'Sessions',
      count: counted(answer.sessions),
      rows: answer.sessions.results.map((s) => ({
        key: String(s.id),
        route: { view: 'session', repo, id: s.id },
        label: `${s.cli}${s.model ? ` · ${s.model}` : ''}`,
        detail: s.summary.split('\n')[0],
      })),
    });
  if (answer.changes?.count)
    sections.push({
      key: 'changes',
      title: 'Changes',
      count: counted(answer.changes),
      rows: answer.changes.results.map((c) => ({
        key: String(c.number),
        route: { view: 'change', repo, number: c.number },
        label: `#${c.number} ${c.title}`,
        detail: `${c.status} · ${c.branch} → ${c.base}`,
      })),
    });
  return sections;
}

/** Whether the answer found nothing in any group. */
export const foundNothing = (answer: SearchAnswer) =>
  answer.results.length === 0 &&
  !answer.memories?.length &&
  !answer.commits?.count &&
  !answer.sessions?.count &&
  !answer.changes?.count;
