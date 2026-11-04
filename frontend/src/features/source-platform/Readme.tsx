// A directory's README, rendered under its files and on the repository's Overview.
import { readQuery } from './codeData';
import { RepoMarkdown } from './RepoMarkdown';
import { repositoryContentKey } from './repositoryContentScope';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

const README = /^readme(\.(md|markdown))?$/i;

/** The README among a directory's entries. */
export const findReadme = <E extends { name: string; type: string }>(entries: E[]) =>
  entries.find((e) => e.type !== 'tree' && README.test(e.name));

type ReadmeProps = {
  repo: string;
  ref: string;
  path: string;
  at?: number;
  scope: string;
  /** Fresh bytes from this page's exact selected commit. */
  preloaded?: { encoding: string; content: string };
};

export function Readme(props: ReadmeProps) {
  return <ReadmeContent key={repositoryContentKey(props.scope, props)} {...props} />;
}

function ReadmeContent({ repo, ref, path, at, preloaded }: ReadmeProps) {
  const file = useSource<{ encoding: string; content: string }>(
    preloaded ? null : `/repos/${repo}/blob?${readQuery(ref, path, at)}`,
  );
  if (file.error) return <Failure error={file.error} onRetry={file.reload} />;
  const data = preloaded ?? file.data;
  if (!data) return <Loading what="README" />;
  if (data.encoding !== 'utf-8') return null;
  return (
    <article className="source-file readme" aria-label={path}>
      <header>
        <code>{path.split('/').pop()}</code>
      </header>
      <RepoMarkdown source={data.content} place={{ repo, ref, path, at }} />
    </article>
  );
}
