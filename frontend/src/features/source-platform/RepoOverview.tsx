import { Failure, Loading } from './SourceStatus';
import { shortSha } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';
import { VersionPicker } from './VersionPicker';

type Edge = { from: string; to: string; references: number };
type Subsystem = {
  path: string;
  files: number;
  symbols: number;
  narrative: string[];
  parse_errors: string[];
  contracts: { authored: number; derived: number; unstated: number; stale: number };
};
type HumanView = {
  commit: string;
  path: string;
  subsystems: Subsystem[];
  dependency_map: {
    nodes: { id: string; label: string; inside: boolean }[];
    edges: Edge[];
    file_edges: Edge[];
    truncated: boolean;
  };
  files_analyzed: number;
  files_truncated: boolean;
  files_limit: number;
};
type Route = Extract<SourceRoute, { view: 'overview' }>;
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Renders `code` spans the narrative marks with backticks. */
function Narrative({ text }: { text: string }) {
  return (
    <p>
      {text.split('`').map((part, i) =>
        // Segments alternate prose and code; their order is fixed, so indexes are stable.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional segments of one string.
        i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
      )}
    </p>
  );
}

function EdgeTable({
  caption,
  edges,
  label,
}: {
  caption: string;
  edges: Edge[];
  label: (id: string) => string;
}) {
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">Depends on</th>
            <th scope="col">References</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e) => (
            <tr key={`${e.from}>${e.to}`}>
              <td>
                <code>{label(e.from)}</code>
              </td>
              <td>
                <code>{label(e.to)}</code>
              </td>
              <td>{e.references}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Human view of one revision: a generated narrative per subsystem and a dependency map.
 * Built by the platform from the tree, symbols and contracts, with no agent services.
 */
export function RepoOverview({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: (r: SourceRoute) => void;
}) {
  const params = new URLSearchParams({ path: route.path, ref: route.ref });
  if (route.at !== undefined) params.set('at', String(route.at));
  const view = useSource<HumanView>(`/repos/${route.repo}/views/human?${params}`);
  const go = (path: string) => onNavigate({ ...route, path });
  const crumbs = route.path.split('/').filter(Boolean);
  const data = view.data;
  const nodes = new Map(data?.dependency_map.nodes.map((n) => [n.id, n]) ?? []);
  const label = (id: string) =>
    `${nodes.get(id)?.label ?? id}${nodes.get(id)?.inside === false ? ' (outside)' : ''}`;
  return (
    <section className="source-overview" aria-label="Overview">
      <div className="source-toolbar">
        <nav aria-label="Subsystem" className="source-crumbs">
          <button type="button" className="quiet" onClick={() => go('')}>
            All subsystems
          </button>
          {crumbs.map((part, i) => (
            <span key={crumbs.slice(0, i + 1).join('/')}>
              /
              <button
                type="button"
                className="quiet"
                onClick={() => go(crumbs.slice(0, i + 1).join('/'))}
              >
                {part}
              </button>
            </span>
          ))}
        </nav>
        <VersionPicker
          repo={route.repo}
          at={route.at}
          onChange={(at) => onNavigate({ ...route, at })}
        />
      </div>
      {route.at !== undefined && (
        <p className="source-note" role="status">
          Time travel: generated from {route.ref} as of log version {route.at}.
        </p>
      )}
      {view.error && <Failure error={view.error} onRetry={view.reload} />}
      {!data && !view.error && <Loading what="overview" />}
      {data && (
        <>
          <p className="source-meta">
            Generated from commit <code>{shortSha(data.commit)}</code> · {data.files_analyzed}{' '}
            source files analysed · references are matched by name, not type-checked.
          </p>
          {data.files_truncated && (
            <p className="source-note" role="status">
              Only the first {data.files_limit} source files were analysed.
            </p>
          )}
          {data.subsystems.length === 0 && (
            <p className="source-empty">No Rust, TypeScript or JavaScript files here.</p>
          )}
          <div className="source-subsystems">
            {data.subsystems.map((s) => (
              <article key={s.path} className="source-subsystem" aria-label={s.path || 'top level'}>
                <header>
                  <h2>
                    {s.path && s.path !== route.path ? (
                      <button type="button" className="quiet" onClick={() => go(s.path)}>
                        {s.path}
                      </button>
                    ) : (
                      s.path || '(top level)'
                    )}
                  </h2>
                  <span className="source-meta">
                    {count(s.files, 'file')} · {count(s.symbols, 'symbol')} ·{' '}
                    {count(s.contracts.authored, 'authored contract')}
                  </span>
                  {s.contracts.stale > 0 && (
                    <span className="source-badge-stale">{s.contracts.stale} stale</span>
                  )}
                </header>
                {s.narrative.map((p) => (
                  <Narrative key={p} text={p} />
                ))}
              </article>
            ))}
          </div>
          <h2 className="source-section">Dependency map</h2>
          {data.dependency_map.edges.length === 0 ? (
            <p className="source-empty">No references cross these subsystems.</p>
          ) : (
            <EdgeTable
              caption="Subsystem dependencies"
              edges={data.dependency_map.edges}
              label={label}
            />
          )}
          {data.dependency_map.file_edges.length > 0 && (
            <details className="source-details">
              <summary>File dependencies ({data.dependency_map.file_edges.length})</summary>
              <EdgeTable
                caption="File dependencies"
                edges={data.dependency_map.file_edges}
                label={(id) => id}
              />
            </details>
          )}
          {data.dependency_map.truncated && (
            <p className="source-note">The map lists the first 500 dependencies.</p>
          )}
        </>
      )}
    </section>
  );
}
