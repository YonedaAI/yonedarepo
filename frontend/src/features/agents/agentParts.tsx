// Pieces the Agents pages share: the agent icons (inline SVG, drawn in the current text
// colour so both themes work), result tiles and the history strip, status chips, and the
// loading / unavailable / not-an-owner states of a managed read.
import type {
  ManagedAgentDefinition,
  ManagedRun,
  RunTile,
} from '../../../../shared/managed-agents';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { when } from '../source-platform/sourceApi';
import type { Loaded } from '../source-platform/useSource';
import { statusLabel, tileTone, valueLabel } from './agentsModel';

const PATHS: Record<ManagedAgentDefinition['icon'] | 'custom', string[]> = {
  code: ['M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16'],
  shield: ['M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z', 'M9 12l2 2 4-4'],
  siren: ['M7 18v-6a5 5 0 0110 0v6M5 18h14v3H5zM12 3v2M4.2 6.2l1.4 1.4M19.8 6.2l-1.4 1.4'],
  custom: ['M12 5v14M5 12h14'],
};

export function AgentIcon({ icon }: { icon: ManagedAgentDefinition['icon'] | 'custom' }) {
  return (
    <span className="agent-icon-tile">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {PATHS[icon].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
}

/** One result: a coloured square with the value spelled out for assistive technology. */
export function ResultTile({
  tile,
}: {
  tile: Pick<RunTile, 'value' | 'status' | 'change' | 'created_at'>;
}) {
  const label = `${valueLabel(tile.value)} on change #${tile.change}, ${when(tile.created_at)}`;
  return (
    <span
      className={`result-tile tone-${tileTone(tile)}`}
      title={label}
      role="img"
      aria-label={label}
    />
  );
}

/** The last six results, newest first, padded with empty slots. */
export function HistoryStrip({ history }: { history: RunTile[] }) {
  const tiles = history.slice(0, 6);
  if (!tiles.length)
    return <p className="source-meta">No runs yet: results show here after the first one.</p>;
  return (
    <ul className="history-strip" aria-label="Last results, newest first">
      {tiles.map((t) => (
        <li key={t.id}>
          <ResultTile tile={t} />
        </li>
      ))}
      {Array.from({ length: 6 - tiles.length }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: empty placeholder slots have no identity.
        <li key={i} aria-hidden="true">
          <span className="result-tile tone-empty" />
        </li>
      ))}
    </ul>
  );
}

export function StatusChip({ run }: { run: Pick<ManagedRun, 'status' | 'value'> }) {
  return <span className={`chip run-${tileTone(run)}`}>{statusLabel(run.status)}</span>;
}

function Unavailable() {
  return (
    <div className="source-empty-state">
      <p>
        <strong>Managed agents are not available here.</strong> This deployment does not run
        YonedaRepo&apos;s managed agents.
      </p>
    </div>
  );
}

function NotOwner() {
  return (
    <div className="source-empty-state">
      <p>
        <strong>Only a workspace owner can see its agents.</strong> Ask an owner of this account or
        organization, or pick a workspace you own.
      </p>
    </div>
  );
}

/** Loading, unavailable, not an owner, or failed; null once there is data to show. */
export function loadState<T>(loaded: Loaded<T>, what: string) {
  if (loaded.loading && !loaded.data) return <Loading what={what} />;
  if (loaded.error && loaded.code === 'FORBIDDEN') return <NotOwner />;
  if (loaded.error && loaded.errorStatus === 404 && !loaded.data) return <Unavailable />;
  if (loaded.error) return <Failure error={loaded.error} onRetry={loaded.reload} what={what} />;
  return null;
}

export function BillingComing({ children }: { children?: React.ReactNode }) {
  return (
    <div className="agents-billing-note" role="note">
      <p>
        {children ??
          'Setting up billing is coming. Until then, the agents YonedaRepo maintains run on your promotional credit.'}
      </p>
      <button type="button" disabled title="Billing is not available yet">
        Set up billing
      </button>
    </div>
  );
}
