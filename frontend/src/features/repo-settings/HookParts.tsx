// Webhook tables: the repository's hooks and one hook's latest delivery attempts.
import { Failure, Loading } from '../source-platform/SourceStatus';
import { when } from '../source-platform/sourceApi';
import type { Loaded } from '../source-platform/useSource';

/** Events a hook can subscribe to (repo_store/hooks.rs EVENTS). */
export const HOOK_EVENTS = [
  'land',
  'merged',
  'refused',
  'branch',
  'tag',
  'check',
  'release',
] as const;

export type Hook = {
  id: number;
  url: string;
  events: string[] | null;
  paths: unknown;
  active: boolean;
  failures?: number;
  pending?: number;
  created_by?: string;
  created_at: number;
  disabled_at?: number | null;
};
export type Delivery = {
  delivery_id: string;
  event: string;
  attempt: number;
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
  at: number;
};

export function HookTable({
  hooks,
  selected,
  onDeliveries,
  onDelete,
}: {
  hooks: Loaded<{ hooks: Hook[] }>;
  selected?: number;
  onDeliveries: (hook: Hook) => void;
  onDelete: (hook: Hook) => void;
}) {
  if (hooks.loading && !hooks.data) return <Loading what="webhooks" />;
  if (hooks.error) return <Failure error={hooks.error} onRetry={hooks.reload} />;
  const rows = hooks.data?.hooks ?? [];
  if (rows.length === 0)
    return <p className="source-empty">No webhooks. Add one below to notify CI or chat.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>URL</th>
            <th>Events</th>
            <th>State</th>
            <th>Added</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id}>
              <td className="settings-url">{h.url}</td>
              <td>{(h.events ?? HOOK_EVENTS).join(', ')}</td>
              <td>
                {h.active ? (
                  <span className="source-check-pass">
                    active{h.pending ? ` · ${h.pending} queued` : ''}
                  </span>
                ) : (
                  <span className="source-check-fail">
                    disabled{h.disabled_at ? ` ${when(h.disabled_at)}` : ''} after {h.failures ?? 0}{' '}
                    failures
                  </span>
                )}
              </td>
              <td>{when(h.created_at)}</td>
              <td className="settings-row-actions">
                <button
                  type="button"
                  className="quiet"
                  aria-pressed={h.id === selected}
                  onClick={() => onDeliveries(h)}
                >
                  Deliveries
                </button>
                <button type="button" className="quiet" onClick={() => onDelete(h)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DeliveryTable({ deliveries }: { deliveries: Loaded<{ deliveries: Delivery[] }> }) {
  if (deliveries.loading && !deliveries.data) return <Loading what="deliveries" />;
  if (deliveries.error) return <Failure error={deliveries.error} onRetry={deliveries.reload} />;
  const rows = deliveries.data?.deliveries ?? [];
  if (rows.length === 0)
    return <p className="source-empty">Nothing delivered yet. Land a change to send one.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <caption>Latest delivery attempts, newest first</caption>
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Attempt</th>
            <th>Result</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={`${d.delivery_id}:${d.attempt}`}>
              <td>{when(d.at)}</td>
              <td>{d.event}</td>
              <td>{d.attempt}</td>
              <td className={d.ok ? 'source-check-pass' : 'source-check-fail'}>
                {d.ok ? `delivered (${d.status})` : `failed: ${d.error ?? `HTTP ${d.status}`}`}
              </td>
              <td>{d.ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
