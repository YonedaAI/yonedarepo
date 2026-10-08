import { useState } from 'react';
import { api } from '../../lib/api';
import type { Graph, GraphNode } from '../../lib/types';
export function GraphTools({
  repo,
  selected,
  onGraph,
  onSelect,
}: {
  repo: string;
  selected?: GraphNode | null;
  onGraph: (graph: Graph | null) => void;
  onSelect: (node: GraphNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [items, setItems] = useState<GraphNode[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function search(next?: string) {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ items: GraphNode[]; next_cursor: string | null }>(
        `repos/${repo}/context_search?${new URLSearchParams({ query, kind, limit: '25', ...(next ? { cursor: next } : {}) })}`,
      );
      setItems((previous) => (next ? [...previous, ...r.items] : r.items));
      setCursor(r.next_cursor);
      onGraph({ nodes: r.items, edges: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        className="context-tools"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          Search context
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Why this approach?"
            maxLength={512}
          />
        </label>
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All context types</option>
            {[
              'intent',
              'requirement',
              'constraint',
              'assumption',
              'finding',
              'alternative',
              'proposed_decision',
              'question',
            ].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Search
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            onGraph(null);
            setItems([]);
            setCursor(null);
          }}
        >
          Show full graph
        </button>
        {selected && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onGraph(
                  await api<Graph>(
                    `repos/${repo}/graph?${new URLSearchParams({ id: selected.id, depth: '3' })}`,
                  ),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Expand selected context
          </button>
        )}
      </form>
      {items.length > 0 && (
        <section className="context-results" aria-label="Context search results">
          {items.map((n) => (
            <button type="button" key={n.id} onClick={() => onSelect(n)}>
              {n.kind}: {n.label}
            </button>
          ))}
          {cursor && (
            <button type="button" disabled={busy} onClick={() => void search(cursor)}>
              More context
            </button>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
