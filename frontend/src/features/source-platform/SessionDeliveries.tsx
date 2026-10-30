// The context a coding session was given: the start packet's items, then each injection
// (a file it read, a new prompt), as the agent hooks recorded them. Labels are the items'
// current text; a prompt itself is never kept.
import { linkTo, type Navigate } from '../shell/useRoute';
import { type Deliveries, deliveryCause } from './memoryModel';
import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { when } from './sourceApi';
import { useSource } from './useSource';

export function SessionDeliveries({
  repo,
  sessionId,
  navigate,
}: {
  repo: string;
  sessionId: string;
  navigate: Navigate;
}) {
  const people = usePeople();
  const loaded = useSource<Deliveries>(
    `/repos/${repo}/context/deliveries?session_id=${encodeURIComponent(sessionId)}`,
  );
  return (
    <section aria-labelledby="session-context-heading">
      <h3 id="session-context-heading">Context delivered</h3>
      {loaded.loading && !loaded.data ? (
        <Loading what="the delivered context" />
      ) : loaded.error ? (
        <Failure error={loaded.error} onRetry={loaded.reload} />
      ) : !loaded.data?.deliveries.length ? (
        <p className="source-empty">
          No context was recorded for this session (its CLI may predate continuous context).
        </p>
      ) : (
        <>
          <p className="source-meta">
            {loaded.data.deliveries.length} deliveries · {loaded.data.bytes} bytes in all
            {loaded.data.truncated ? ' · showing the first 500' : ''}
          </p>
          <ol className="agent-list session-deliveries">
            {loaded.data.deliveries.map((d) => (
              <li key={d.seq}>
                <span>
                  <strong>{deliveryCause(d)}</strong>{' '}
                  <span className="source-meta">
                    · {d.items.length} items · {d.bytes} bytes · {people.principal(d.principal)} ·{' '}
                    {when(d.at)}
                  </span>
                </span>
                <ul className="memory-anchors">
                  {d.items.map((i) => (
                    <li key={`${i.type}:${i.id}`}>
                      {i.type === 'change' ? (
                        <a {...linkTo({ view: 'change', repo, number: i.id }, navigate)}>
                          {i.label ?? `change #${i.id}`}
                        </a>
                      ) : i.type === 'session' ? (
                        <a {...linkTo({ view: 'session', repo, id: i.id }, navigate)}>
                          {i.label ?? `session #${i.id}`}
                        </a>
                      ) : (
                        <span>
                          <span className="chip">{i.type}</span> {i.label ?? `#${i.id}`}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
