import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { GraphNode } from '../../lib/types';
import { SourceDiff } from '../exploration/SourceDiff';
import { EvidenceFields, RecordedContent } from './EvidenceFields';
import { authorityLabel } from './evidenceView';
export function EvidencePanel({
  node,
  repo,
  onClose,
}: {
  node: GraphNode;
  repo: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const diffDigest = node.kind === 'candidate' ? node.data.diff_digest : undefined;
  const digest = diffDigest ?? node.data.digest ?? node.data.transcript ?? node.data.evidence;
  useEffect(() => {
    let current = true;
    setContent(null);
    setError('');
    if (digest)
      void api<{ content: string }>(`repos/${repo}/evidence?digest=${encodeURIComponent(digest)}`)
        .then((value) => {
          if (current) setContent(value.content);
        })
        .catch((error) => {
          if (current) setError(error.message);
        });
    return () => {
      current = false;
    };
  }, [repo, digest]);
  return (
    <aside className="evidence-panel">
      <div>
        <span className="status">{node.kind.replaceAll('_', ' ')}</span>
        <button type="button" aria-label="Close evidence" className="icon-button" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <h2>{node.label}</h2>
      <p className="evidence-author">
        {authorityLabel(node)} · Recorded by {node.author.replaceAll('_', ' ')}
      </p>
      <time>{new Date(node.recorded_at).toLocaleString()}</time>
      {digest && (
        <section>
          <h3>{diffDigest ? 'Source changes' : 'Recorded evidence'}</h3>
          {error ? (
            <p role="alert">{error}</p>
          ) : content !== null ? (
            diffDigest ? (
              <SourceDiff diff={content} />
            ) : (
              <RecordedContent content={content} />
            )
          ) : (
            <p role="status">Loading evidence…</p>
          )}
        </section>
      )}
      {!diffDigest && node.kind === 'candidate' && typeof node.data.diff === 'string' && (
        <section>
          <h3>Source changes</h3>
          <SourceDiff diff={node.data.diff} />
        </section>
      )}
      <section>
        <h3>Recorded fields</h3>
        <EvidenceFields value={node.data} />
      </section>
      <details>
        <summary>Raw JSON record</summary>
        <pre>{JSON.stringify(node.data, null, 2)}</pre>
      </details>
      {content && (
        <details>
          <summary>Raw evidence content</summary>
          <pre>{content}</pre>
        </details>
      )}
    </aside>
  );
}
