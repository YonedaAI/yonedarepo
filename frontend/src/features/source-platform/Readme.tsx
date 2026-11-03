// A directory's README, rendered under its files and on the repository's Overview.
import { readQuery } from './codeData';
import { RepoMarkdown } from './RepoMarkdown';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

const README = /^readme(\.(md|markdown))?$/i;

/** The README among a directory's entries. */
export const findReadme = <E extends { name: string; type: string }>(entries: E[]) =>
  entries.find((e) => e.type !== 'tree' && README.test(e.name));

export function Readme({
  repo,
  ref,
  path,
  at,
}: {
  repo: string;
  ref: string;
  path: string;
  at?: number;
}) {
  const file = useSource<{ encoding: string; content: string }>(
    `/repos/${repo}/blob?${readQuery(ref, path, at)}`,
  );
  if (file.error) return <Failure error={file.error} onRetry={file.reload} />;
  if (!file.data) return <Loading what="README" />;
  if (file.data.encoding !== 'utf-8') return null;
  return (
    <article className="source-file readme" aria-label={path}>
      <header>
        <code>{path.split('/').pop()}</code>
      </header>
      <RepoMarkdown source={file.data.content} place={{ repo, ref, path, at }} />
    </article>
  );
}
