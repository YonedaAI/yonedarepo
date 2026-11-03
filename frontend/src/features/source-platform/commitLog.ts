// What `GET /repos/:id/log` answers: a branch's commits, newest first.
export type LogCommit = {
  commit: string;
  message: string;
  principal: string;
  author_name?: string | null;
  authored_at?: number | null;
  landed?: { version: number; landed_at: number };
  break_glass?: string | null;
  /** How many files it changed; absent from an older server. */
  files_changed?: number;
};

/** When the commit was written, or landed if it records neither. */
export const commitTime = (commit: {
  authored_at?: number | null;
  landed?: { landed_at: number } | null;
}) => commit.authored_at ?? commit.landed?.landed_at ?? undefined;

/** The log stops counting a commit's files here (`repo_store/reads.rs`). */
const FILES_COUNTED = 1_001;

/** "3 files", or nothing for a commit that records none (or a server that doesn't say). */
export function filesLabel(files: number | undefined) {
  if (!files) return undefined;
  if (files >= FILES_COUNTED) return `${(FILES_COUNTED - 1).toLocaleString()}+ files`;
  return files === 1 ? '1 file' : `${files.toLocaleString()} files`;
}

const dayName = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** `commits` in their order, a band each time the day changes. The last day of a list cut at
 * `limit` may hold more than was read, and its count says so. */
export function commitDays(commits: LogCommit[], limit: number) {
  const days: { day: string; count: string; commits: LogCommit[] }[] = [];
  for (const commit of commits) {
    const at = commitTime(commit);
    const day = at ? dayName(at) : 'Unknown date';
    const last = days.at(-1);
    if (last?.day === day) last.commits.push(commit);
    else days.push({ day, count: '', commits: [commit] });
  }
  days.forEach((day, at) => {
    const cut = at === days.length - 1 && commits.length >= limit;
    const n = day.commits.length;
    day.count = cut ? `${n}+ commits` : n === 1 ? '1 commit' : `${n} commits`;
  });
  return days;
}
