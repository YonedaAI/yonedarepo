// What `GET /repos/:id/log` answers: a branch's commits, newest first.
export type LogCommit = {
  commit: string;
  message: string;
  principal: string;
  author_name?: string | null;
  authored_at?: number | null;
  landed?: { version: number; landed_at: number };
  break_glass?: string | null;
};

/** When the commit was written, or landed if it records neither. */
export const commitTime = (commit: LogCommit) =>
  commit.authored_at ?? commit.landed?.landed_at ?? undefined;
