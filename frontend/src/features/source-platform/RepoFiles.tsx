import { File, Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FileBlame } from './FileBlame';
import { Failure, Loading } from './SourceStatus';
import { SourceApiError, shortSha, sourceApi, when } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type Entry = { name: string; type: string; id: string };
type FileBody = {
  commit: string;
  size: number;
  encoding: string;
  content: string;
  executable: boolean;
};
type Listing = { kind: 'tree'; commit: string; entries: Entry[] } | ({ kind: 'file' } & FileBody);
type Route = Extract<SourceRoute, { view: 'files' }>;

function query(route: Route, path: string) {
  const params = new URLSearchParams({ path, ref: route.ref });
  if (route.at !== undefined) params.set('at', String(route.at));
  return params.toString();
}

/** Reads `path` as a directory, falling back to a file when it is not one. */
function useListing(route: Route) {
  const [state, setState] = useState<{ value?: Listing; error?: string; empty?: boolean }>({});
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the same location.
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const base = `/repos/${route.repo}`;
    setState({});
    sourceApi(`${base}/tree?${query(route, route.path)}`, { signal })
      .then((tree) => setState({ value: { kind: 'tree', ...tree } }))
      .catch(async (e) => {
        if (signal.aborted) return;
        if (e instanceof SourceApiError && /not a directory/.test(e.message)) {
          const file = await sourceApi(`${base}/blob?${query(route, route.path)}`, { signal });
          setState({ value: { kind: 'file', ...file } });
        } else if (e instanceof SourceApiError && e.code === 'NOT_FOUND') setState({ empty: true });
        else throw e;
      })
      .catch((e) => !signal.aborted && setState({ error: e.message }));
    return () => controller.abort();
  }, [route.repo, route.path, route.ref, route.at, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function RepoFiles({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: (r: SourceRoute) => void;
}) {
  const listing = useListing(route);
  const [blaming, setBlaming] = useState(false);
  const txlog = useSource<{
    entries: { version: number; kind: string; committed_at_ms: number }[];
    version: number;
  }>(`/repos/${route.repo}/txlog?limit=500`);
  const go = (path: string) => onNavigate({ ...route, path });
  const crumbs = route.path.split('/').filter(Boolean);
  return (
    <section className="source-files" aria-label="Files">
      <div className="source-toolbar">
        <nav aria-label="Path" className="source-crumbs">
          <button type="button" className="quiet" onClick={() => go('')}>
            {route.ref}
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
        <label className="source-version">
          Version
          <select
            value={route.at ?? ''}
            onChange={(e) =>
              onNavigate({
                ...route,
                at: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          >
            <option value="">Latest{txlog.data ? ` (v${txlog.data.version})` : ''}</option>
            {[...(txlog.data?.entries ?? [])].reverse().map((entry) => (
              <option key={entry.version} value={entry.version}>
                v{entry.version} · {entry.kind} · {when(entry.committed_at_ms)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {route.at !== undefined && (
        <p className="source-note" role="status">
          Time travel: showing {route.ref} as of log version {route.at}. Reads are pinned and
          immutable.
        </p>
      )}
      {listing.error && <Failure error={listing.error} onRetry={listing.reload} />}
      {listing.empty && (
        <p className="source-empty">
          {route.path || route.ref} does not exist{' '}
          {route.at === undefined ? 'on this branch' : 'at this version'}.
        </p>
      )}
      {!listing.value && !listing.error && !listing.empty && <Loading what="files" />}
      {listing.value?.kind === 'tree' && (
        <>
          <p className="source-meta">
            Commit{' '}
            <a
              href={`/source/${route.repo}/commit/${listing.value.commit}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate({
                  view: 'commit',
                  repo: route.repo,
                  commit: (listing.value as Listing).commit,
                });
              }}
            >
              <code>{shortSha(listing.value.commit)}</code>
            </a>
          </p>
          <ul className="source-tree">
            {[...listing.value.entries]
              .sort(
                (a, b) =>
                  Number(b.type === 'tree') - Number(a.type === 'tree') ||
                  a.name.localeCompare(b.name),
              )
              .map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="quiet"
                    disabled={entry.type === 'gitlink'}
                    onClick={() => go(route.path ? `${route.path}/${entry.name}` : entry.name)}
                  >
                    {entry.type === 'tree' ? (
                      <Folder size={15} aria-hidden />
                    ) : (
                      <File size={15} aria-hidden />
                    )}
                    {entry.name}
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
      {listing.value?.kind === 'file' && (
        <article className="source-file">
          <header>
            <code>{route.path}</code>
            <span>
              {listing.value.size} bytes{listing.value.executable ? ' · executable' : ''}
            </span>
            {route.at === undefined && listing.value.encoding === 'utf-8' && (
              <button
                type="button"
                className="quiet"
                aria-pressed={blaming}
                onClick={() => setBlaming((b) => !b)}
              >
                {blaming ? 'Hide blame' : 'Blame'}
              </button>
            )}
          </header>
          {blaming && route.at === undefined ? (
            <FileBlame
              repo={route.repo}
              path={route.path}
              refName={route.ref}
              onNavigate={onNavigate}
            />
          ) : listing.value.encoding === 'utf-8' ? (
            <pre>{listing.value.content}</pre>
          ) : (
            <p className="source-empty">Binary file not shown.</p>
          )}
        </article>
      )}
    </section>
  );
}
