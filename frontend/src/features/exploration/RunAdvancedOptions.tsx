import type { GraphNode } from '../../lib/types';

const contextKinds = new Set([
  'intent',
  'requirement',
  'constraint',
  'assumption',
  'finding',
  'alternative',
  'proposed_decision',
  'question',
  'decision',
  'context',
  'candidate',
  'evaluation',
  'execution',
]);

export function RunAdvancedOptions({
  nodes,
  context,
  policy,
  locked,
  onContextChange,
  onPolicyChange,
}: {
  nodes: GraphNode[];
  context: string[];
  policy: string;
  locked: boolean;
  onContextChange: (context: string[]) => void;
  onPolicyChange: (policy: string) => void;
}) {
  const reusable = nodes.filter((node) => contextKinds.has(node.kind) || context.includes(node.id));
  return (
    <>
      <details>
        <summary>Reuse existing context ({context.length} selected)</summary>
        {!reusable.length && <p>This repository has no reusable context yet.</p>}
        {!!reusable.length && (
          <p>
            Up to 50 records can be frozen into this brief, including prior artifacts and decisions.
            Agent findings remain assertions until verified or adopted.
          </p>
        )}
        {reusable.map((node) => (
          <label key={node.id}>
            <span>
              <input
                type="checkbox"
                disabled={locked || (context.length >= 50 && !context.includes(node.id))}
                checked={context.includes(node.id)}
                onChange={(event) =>
                  onContextChange(
                    event.target.checked
                      ? [...context, node.id]
                      : context.filter((id) => id !== node.id),
                  )
                }
              />{' '}
              {node.kind}: {node.label}
            </span>
          </label>
        ))}
      </details>
      <details>
        <summary>Build and independent check commands</summary>
        <p>
          The default website check only confirms an HTML entrypoint, title and viewport. Add
          meaningful tests for your project. Commands run in a clean Node 24 / Rust 1.94 / Python
          standard library environment. Static output is served from static_dir.
        </p>
        <label>
          Approved build profile (JSON)
          <textarea
            className="profile-input"
            value={policy}
            onChange={(event) => onPolicyChange(event.target.value)}
            required
            disabled={locked}
          />
        </label>
      </details>
    </>
  );
}
