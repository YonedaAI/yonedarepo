import { Activity, Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { Graph, Snapshot } from '../../lib/types';
export function HistoryTools({
  snapshot,
  onGraph,
  onError,
}: {
  snapshot: Snapshot;
  onGraph: (graph: Graph) => void;
  onError: (message: string) => void;
}) {
  const [path, setPath] = useState(
    snapshot.repository.policy?.build?.static_dir
      ? `${snapshot.repository.policy.build.static_dir}/index.html`
      : 'src/main.rs',
  );
  const [commit, setCommit] = useState(snapshot.repository.published_commit);
  const [assumption, setAssumption] = useState('');
  const [value, setValue] = useState(350);
  const [message, setMessage] = useState('');
  const assumptions = snapshot.nodes.filter(
    (n) =>
      n.kind === 'assumption' &&
      typeof n.data.limit === 'number' &&
      typeof n.data.metric === 'string',
  );
  const current = assumptions.find((n) => n.id === assumption) ?? assumptions[0];
  async function why() {
    try {
      const graph = await api<Graph>(
        `repos/${snapshot.repository.id}/why?${new URLSearchParams({ commit, path })}`,
      );
      onGraph(graph);
      setMessage(
        graph.coverage === 'unknown'
          ? 'No recorded decision covers this exact revision and path.'
          : graph.truncated
            ? 'Showing a bounded part of the recorded history. Some connected context is outside this view.'
            : 'Showing recorded context for this source revision.',
      );
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function incident() {
    if (!current) return;
    try {
      const result = await api<{ status: string }>(`repos/${snapshot.repository.id}/observe`, {
        id: `incident-${crypto.randomUUID()}`,
        assumption: current.id,
        metric: current.data.metric,
        value,
        simulated: true,
      });
      const graph = await api<Graph>(
        `repos/${snapshot.repository.id}/graph?${new URLSearchParams({ id: current.id, depth: '8' })}`,
      );
      onGraph(graph);
      setMessage(`Simulated observation recorded: ${result.status.replaceAll('_', ' ')}.`);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="history-tools">
      <section>
        <h2>
          <Search size={18} />
          Why is this code here?
        </h2>
        <p>
          Follow recorded evidence from a source revision to its original intent and alternatives.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void why();
          }}
        >
          <label>
            Commit
            <input value={commit} onChange={(e) => setCommit(e.target.value)} required />
          </label>
          <label>
            Path
            <input value={path} onChange={(e) => setPath(e.target.value)} required />
          </label>
          <button type="submit">Trace history</button>
        </form>
      </section>
      <section>
        <h2>
          <Activity size={18} />
          Challenge an assumption
        </h2>
        <p>Record a simulated incident without changing what the agent originally asserted.</p>
        {current ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void incident();
            }}
          >
            <label>
              Recorded assumption
              <select value={current.id} onChange={(e) => setAssumption(e.target.value)}>
                {assumptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {current.data.metric}
              <input
                type="number"
                value={value}
                onChange={(e) => setValue(Number(e.target.value))}
                required
              />
            </label>
            <button type="submit">Record simulated observation</button>
          </form>
        ) : (
          <p className="empty-note">Research has not recorded a bounded assumption yet.</p>
        )}
      </section>
      {message && (
        <p role="status" className="history-message">
          {message}
        </p>
      )}
    </div>
  );
}
