// The change's route: how it got here, oldest first, from one read
// (`GET /changes/:n/route`): commits, pushes, the coding sessions behind them with what they
// read and were delivered, and check verdicts. Pushes come with the change itself, so they
// stay on the timeline when the route can't be read.
import type { ChangeRoute as Route } from '../../../../shared/contracts/change-route';
import { linkTo, type Navigate } from '../shell/useRoute';
import { summaryText } from './agentModel';
import type { Push } from './changeModel';
import { PushItem } from './PushItem';
import { usePeople } from './people';
import {
  changeRoutePath,
  deliveredItems,
  deliveredKey,
  deliveredLine,
  type RouteItem,
  routeCut,
  routeSummary,
  routeTimeline,
  sessionBytes,
} from './routeModel';
import { DeliveredItem } from './SessionDeliveries';
import { Failure } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { useSource } from './useSource';

function CommitLink({ sha, onCommit }: { sha: string; onCommit?: (sha: string) => void }) {
  return (
    <a
      href={`#${sha}`}
      onClick={(e) => {
        e.preventDefault();
        onCommit?.(sha);
      }}
    >
      <code>{shortSha(sha)}</code>
    </a>
  );
}

function SessionStep({
  repo,
  item,
  navigate,
}: {
  repo: string;
  item: Extract<RouteItem, { kind: 'session' }>;
  navigate: Navigate;
}) {
  const people = usePeople();
  const { session: s, delivered } = item;
  const bytes = sessionBytes(s);
  return (
    <>
      <a className="agent-session-ref" {...linkTo({ view: 'session', repo, id: s.id }, navigate)}>
        <strong>{s.cli}</strong>
        {s.model && ` · ${s.model}`}
      </a>{' '}
      <span className="source-meta">
        · {people.principal(s.recorded_by)} · {when(s.at)}
        {bytes && ` · ${bytes}`}
      </span>
      <p className="source-session-summary">{summaryText(s)}</p>
      {delivered.length > 0 && (
        <details>
          <summary className="source-meta">{deliveredLine(delivered)}</summary>
          <ul className="memory-anchors">
            {deliveredItems(delivered).map((i) => (
              <li key={deliveredKey(i)}>
                <DeliveredItem repo={repo} item={i} navigate={navigate} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Step({
  repo,
  item,
  navigate,
  onCommit,
}: {
  repo: string;
  item: RouteItem;
  navigate: Navigate;
  onCommit?: (sha: string) => void;
}) {
  const people = usePeople();
  switch (item.kind) {
    case 'push':
      return <PushItem push={item.push} onCommit={onCommit} />;
    case 'session':
      return <SessionStep repo={repo} item={item} navigate={navigate} />;
    case 'commit':
      return (
        <>
          <CommitLink sha={item.commit.commit} onCommit={onCommit} /> {item.commit.subject}{' '}
          <span className="source-meta">
            · {people.principal(item.commit.principal)} · {when(item.at)}
          </span>
        </>
      );
    case 'check':
      return (
        <>
          <span className={`chip ${item.check.status === 'pass' ? 'run-good' : 'run-bad'}`}>
            {item.check.status}
          </span>{' '}
          <strong>{item.check.name}</strong> on{' '}
          <CommitLink sha={item.check.commit} onCommit={onCommit} />{' '}
          <span className="source-meta">
            · {people.principal(item.check.principal)} · {when(item.at)}
          </span>
        </>
      );
  }
}

const key = (item: RouteItem) => {
  switch (item.kind) {
    case 'push':
      return `p${item.push.version}`;
    case 'session':
      return `s${item.session.id}`;
    case 'commit':
      return `c${item.commit.commit}`;
    case 'check':
      return `k${item.check.commit}${item.check.name}`;
  }
};

export function ChangeRoute({
  repo,
  number,
  pushes,
  navigate,
  onCommit,
}: {
  repo: string;
  number: number;
  /** The branch's pushes, from the change itself. */
  pushes: Push[];
  navigate: Navigate;
  onCommit?: (sha: string) => void;
}) {
  const loaded = useSource<Route>(changeRoutePath(repo, number));
  const items = routeTimeline(loaded.data, pushes);
  const cut = loaded.data && routeCut(loaded.data.truncated);
  return (
    <section aria-labelledby="change-route-heading">
      <h3 id="change-route-heading">Route</h3>
      {loaded.data && (
        <p className="source-meta">{routeSummary(loaded.data.totals, loaded.data.sessions)}</p>
      )}
      {loaded.loading && !loaded.data && <p className="source-empty">Loading the route…</p>}
      {loaded.error && <Failure error={loaded.error} onRetry={loaded.reload} what="the route" />}
      {loaded.data && items.length === 0 && (
        <p className="source-empty">Nothing on this route: the change has no commits of its own.</p>
      )}
      {items.length > 0 && (
        <ol className="change-route">
          {items.map((item) => (
            <li key={key(item)} data-kind={item.kind}>
              <Step repo={repo} item={item} navigate={navigate} onCommit={onCommit} />
            </li>
          ))}
        </ol>
      )}
      {cut && <p className="source-meta">Showing only the newest {cut}.</p>}
    </section>
  );
}
