import { useState } from 'react';
import { api } from '../../lib/api';
import type { Graph, GraphNode } from '../../lib/types';
export function GraphTools({
  repo,
  selected,
  fullGraphLabel = 'Show full graph',
  onGraph,
  onSelect,
}: {
  repo: string;
  selected?: GraphNode | null;
  fullGraphLabel?: string;
  onGraph: (graph: Graph | null) => void;
  onSelect: (node: GraphNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [items, setItems] = useState<GraphNode[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  async function search(next?: string) {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ items: GraphNode[]; next_cursor: string | null }>(
        `repos/${repo}/context_search?${new URLSearchParams({ query, kind, limit: '25', ...(next ? { cursor: next } : {}) })}`,
      );
      const found = next ? [...items, ...r.items] : r.items;
      setItems(found);
      setSearched(true);
      setCursor(r.next_cursor);
      onGraph({ nodes: found, edges: [] });
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
              <option key={k} value={k}>
                {k.replaceAll('_', ' ')}
              </option>
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
            setSearched(false);
            setError('');
            setQuery('');
            setKind('');
          }}
        >
          {fullGraphLabel}
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
                    `repos/${repo}/graph?${new URLSearchParams({ id: selected.id, depth: '1' })}`,
                  ),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Expand one neighboring step
          </button>
        )}
      </form>
      {searched && !busy && !items.length && (
        <p role="status">No matching context. Try another search or show the full graph.</p>
      )}
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
