// A repository's Markdown, in full: READMEs, Markdown files, comments and session transcripts.
// The parser is its own chunk, so no first page carries it; until it arrives the small reader
// shows the words in the same place. The site's own pages stay on that reader: they are
// prerendered, and their content is ours.
import { lazy, Suspense } from 'react';
import { type ImageResolver, Markdown } from './markdown';
import { loadRichMarkdown } from './markdownLoader';

const GfmDocument = lazy(() =>
  loadRichMarkdown().then(({ GfmDocument }) => ({ default: GfmDocument })),
);

/** Past this a document is its text: a reader's tab should not parse a megabyte. */
const MAX_CHARS = 512 * 1024;

export function RichMarkdown({
  source,
  shift = 1,
  anchors = false,
  image,
}: {
  source: string;
  shift?: number;
  anchors?: boolean;
  image?: ImageResolver;
}) {
  if (source.length > MAX_CHARS) return <pre>{source}</pre>;
  return (
    <div className="md-body">
      <Suspense fallback={<Markdown source={source} shift={shift} />}>
        <GfmDocument source={source} shift={shift} anchors={anchors} image={image} />
      </Suspense>
    </div>
  );
}
