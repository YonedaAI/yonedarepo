import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { GraphNode } from '../../lib/types';
export function EvidencePanel({
  node,
  repo,
  onClose,
}: {
  node: GraphNode;
  repo: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const digest = node.data.digest ?? node.data.transcript ?? node.data.evidence;
  useEffect(() => {
    let current = true;
    setContent('');
    if (digest)
      void api<{ content: string }>(`repos/${repo}/evidence?digest=${encodeURIComponent(digest)}`)
        .then((value) => {
          if (current) setContent(value.content);
        })
        .catch((error) => {
          if (current) setContent(error.message);
        });
    return () => {
      current = false;
    };
  }, [repo, digest]);
  return (
    <aside className="evidence-panel">
      <div>
        <span className="status">{node.kind}</span>
        <button type="button" aria-label="Close evidence" className="icon-button" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <h2>{node.label}</h2>
      <p className="evidence-author">Recorded by {node.author.replaceAll('_', ' ')}</p>
      <time>{new Date(node.recorded_at).toLocaleString()}</time>
      {digest && (
        <section>
          <h3>Recorded evidence</h3>
          <pre>{content || 'Loading evidence…'}</pre>
        </section>
      )}
      <details open={!digest}>
        <summary>Record details</summary>
        <pre>{JSON.stringify(node.data, null, 2)}</pre>
      </details>
    </aside>
  );
}
