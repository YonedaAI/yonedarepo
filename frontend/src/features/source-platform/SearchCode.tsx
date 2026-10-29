// The code results of a search: each file with its match count and its first lines, the
// matched spans marked, and the rest of its lines behind "+N more in this file".
import { useState } from 'react';
import { type CodeHit, highlight, type Skipped, shownLines } from './searchModel';
import type { SourceRoute } from './sourceRoute';

/** Text files not content-searched named in the note; the rest are counted. */
const NAMED = 5;

const MATCHED = { word: 'whole word', path: 'path', substring: 'in a word' } as const;

function CodeFile({
  repo,
  hit,
  onNavigate,
}: {
  repo: string;
  hit: CodeHit;
  onNavigate: (r: SourceRoute) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { lines, more } = shownLines(hit, expanded);
  const hidden = hit.lines.length - lines.length;
  const open = () => onNavigate({ view: 'files', repo, path: hit.path, ref: 'main' });
  return (
    <article className="source-file search-file">
      <header>
        <a
          href={`/source/${repo}/files/${hit.path}`}
          onClick={(e) => {
            e.preventDefault();
            open();
          }}
        >
          <code>{hit.path}</code>
        </a>
        <span className="source-meta">
          {hit.hits ? `${hit.hits} ${hit.hits === 1 ? 'match' : 'matches'}` : 'path matches'}
          {hit.match && hit.match !== 'path' ? ` · ${MATCHED[hit.match]}` : ''}
        </span>
      </header>
      {lines.length > 0 && (
        <pre>
          {lines.map((l) => (
            <div key={l.line}>
              <span className="search-line-number">{String(l.line).padStart(5)}</span>
              {'  '}
              {highlight(l.text, l.ranges).map((piece, i) =>
                piece.mark ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional
                  <mark key={i}>{piece.text}</mark>
                ) : (
                  piece.text
                ),
              )}
            </div>
          ))}
        </pre>
      )}
      {more > 0 &&
        (hidden > 0 ? (
          <button
            type="button"
            className="text-button search-more"
            onClick={() => setExpanded(true)}
          >
            +{more} more in this file
          </button>
        ) : (
          <a
            className="search-more"
            href={`/source/${repo}/files/${hit.path}`}
            onClick={(e) => {
              e.preventDefault();
              open();
            }}
          >
            +{more} more in this file
          </a>
        ))}
    </article>
  );
}

export function SearchCode({
  repo,
  results,
  skipped,
  skippedCount,
  onNavigate,
}: {
  repo: string;
  results: CodeHit[];
  skipped: Skipped[];
  skippedCount: number;
  onNavigate: (r: SourceRoute) => void;
}) {
  return (
    <>
      {results.length ? <h3>Code</h3> : null}
      {results.map((hit) => (
        <CodeFile key={hit.path} repo={repo} hit={hit} onNavigate={onNavigate} />
      ))}
      {skippedCount ? (
        <p className="search-skipped">
          Not searched inside:{' '}
          {skipped
            .slice(0, NAMED)
            .map((f) => `${f.path} (${f.reason})`)
            .join(', ')}
          {skippedCount > NAMED ? `, and ${skippedCount - NAMED} more` : ''}
        </p>
      ) : null}
    </>
  );
}
