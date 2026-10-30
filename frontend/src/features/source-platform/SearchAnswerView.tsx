// One repository's answer to a search, the repository's Search tab and the Search page alike:
// its commits, sessions and changes, its memories, then its code.
import { useId } from 'react';
import { usePeople } from './people';
import { SearchCode } from './SearchCode';
import { recordSections, type SearchAnswer } from './searchModel';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';

export function SearchAnswerView({
  repo,
  answer,
  onNavigate,
}: {
  repo: string;
  answer: SearchAnswer;
  onNavigate: (r: SourceRoute) => void;
}) {
  const people = usePeople();
  const id = useId();
  return (
    <>
      {recordSections(repo, answer, people.principal).map((section) => (
        <section
          key={section.key}
          aria-labelledby={`${id}-${section.key}`}
          className="search-records"
        >
          <h3 id={`${id}-${section.key}`}>
            {section.title} <span className="source-meta">({section.count})</span>
          </h3>
          <ul className="agent-list">
            {section.rows.map((row) => (
              <li key={row.key}>
                <a
                  href={formatSourceRoute(row.route)}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(row.route);
                  }}
                >
                  {row.label}
                </a>
                <p className="source-meta">{row.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {answer.memories?.length ? (
        <section aria-labelledby={`${id}-memories`} className="search-memories">
          <h3 id={`${id}-memories`}>Memories</h3>
          <ul className="agent-list">
            {answer.memories.map((m) => (
              <li key={m.id}>
                <span>
                  <span className="chip">{m.memory.kind}</span>{' '}
                  {m.stale && <span className="chip memory-stale">stale</span>}{' '}
                  <a
                    href={formatSourceRoute({ view: 'agents', repo, section: 'memories' })}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate({ view: 'agents', repo, section: 'memories' });
                    }}
                  >
                    #{m.id}
                  </a>
                </span>
                <p className="memory-text">{m.text}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <SearchCode
        repo={repo}
        results={answer.results}
        skipped={answer.skipped_files}
        skippedCount={answer.skipped_count}
        onNavigate={onNavigate}
      />
    </>
  );
}
