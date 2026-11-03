import { useEffect, useRef, useState } from 'react';
import type {
  ContributionItem,
  ContributionDetails as Details,
} from '../../../../shared/contributions';
import { Dialog } from '../../components/Dialog';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { SourceApiError, sourceApi } from '../source-platform/sourceApi';
import { linkTo, type Navigate } from './useRoute';

export function ContributionDetails({
  title,
  count,
  buckets,
  snapshots,
  onClose,
  onRefresh,
  navigate,
}: {
  title: string;
  count: number;
  buckets: number[];
  snapshots: Record<string, string>;
  onClose: () => void;
  onRefresh: () => void;
  navigate: Navigate;
}) {
  const recorded = useRef<ContributionItem[]>([]);
  const [items, setItems] = useState<ContributionItem[]>([]);
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [request, setRequest] = useState('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const query = new URLSearchParams({
    hours: buckets.join(','),
    snapshots: JSON.stringify(snapshots),
  });
  if (request) query.set('cursors', request);
  const path = `/activity/contributions?${query}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately repeats this page.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    sourceApi<Details>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.partial || data.total !== count)
          throw new SourceApiError(
            'ACTIVITY_CHANGED',
            'Activity changed. Refresh to see the latest contributions.',
            409,
          );
        const combined = [
          ...new Map(
            [...recorded.current, ...data.items].map((item) => [
              `${item.repo}:${item.commit}`,
              item,
            ]),
          ).values(),
        ];
        if (!Object.values(data.cursors).some(Boolean) && combined.length !== count)
          throw new SourceApiError(
            'ACTIVITY_CHANGED',
            'Activity changed. Refresh to see the latest contributions.',
            409,
          );
        recorded.current = combined;
        setItems(combined);
        setCursors(data.cursors);
        setLoading(false);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setChanged(failure instanceof SourceApiError && failure.code === 'ACTIVITY_CHANGED');
        setError(failure.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, retry, count]);
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="contribution-details">
        <p className="home-total">
          {count} {count === 1 ? 'commit' : 'commits'} · Recorded time
        </p>
        {buckets.map((bucket) => (
          <p className="home-total" key={bucket}>
            {new Date(bucket).toISOString().slice(0, 16).replace('T', ' ')}–
            {new Date(bucket + 3_600_000).toISOString().slice(11, 16)} UTC
          </p>
        ))}
        <ul className="contribution-list">
          {items.map((item) => (
            <li key={`${item.repo}:${item.commit}`}>
              <a
                {...linkTo(
                  { view: 'commit', repo: item.repo, commit: item.commit },
                  (route, options) => {
                    onClose();
                    navigate(route, options);
                  },
                )}
              >
                <strong>{item.subject || item.commit.slice(0, 8)}</strong>
                <span>
                  {item.name} · <code>{item.commit.slice(0, 8)}</code>
                </span>
                <time dateTime={new Date(item.at).toISOString()}>
                  {new Date(item.at).toLocaleString(undefined, { timeZoneName: 'short' })}
                </time>
              </a>
            </li>
          ))}
        </ul>
        {loading && <Loading what="contributions" />}
        {error && (
          <Failure
            error={error}
            what="contributions"
            onRetry={changed ? undefined : () => setRetry((n) => n + 1)}
          />
        )}
        {changed && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onRefresh();
            }}
          >
            Refresh activity
          </button>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="home-empty">No contributions in this hour.</p>
        )}
        {!loading && !error && Object.values(cursors).some(Boolean) && (
          <button
            type="button"
            className="quiet"
            onClick={() => setRequest(JSON.stringify(cursors))}
          >
            Load more
          </button>
        )}
      </div>
    </Dialog>
  );
}
