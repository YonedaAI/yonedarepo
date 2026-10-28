import { type DiffChange, DiffFiles } from './DiffFiles';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

export function CommitDiff({
  repo,
  commit,
  classes = {},
}: {
  repo: string;
  commit: string;
  classes?: Record<string, string>;
}) {
  const diff = useSource<{ changes: DiffChange[] }>(`/repos/${repo}/diff?head=${commit}&patch=1`);
  if (diff.error) return <Failure error={diff.error} onRetry={diff.reload} />;
  if (!diff.data) return <Loading what="changes" />;
  return <DiffFiles changes={diff.data.changes} classes={classes} />;
}
