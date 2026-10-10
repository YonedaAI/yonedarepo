import { fieldLabel } from './evidenceView';

export function EvidenceFields({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span className="subtle">Not recorded</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value !== 'object') return <span className="evidence-text">{String(value)}</span>;
  if (depth >= 4)
    return (
      <details>
        <summary>More recorded fields</summary>
        <EvidenceFields value={value} />
      </details>
    );
  if (Array.isArray(value))
    return value.length ? (
      <ul className="evidence-values">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable evidence preserves its recorded order.
          <li key={index}>
            <EvidenceFields value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    ) : (
      <span className="subtle">None recorded</span>
    );
  return (
    <dl className="evidence-fields">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>
            {key.endsWith('_at') && typeof item === 'number' ? (
              new Date(item).toLocaleString()
            ) : (
              <EvidenceFields value={item} depth={depth + 1} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RecordedContent({ content }: { content: string }) {
  try {
    return <EvidenceFields value={JSON.parse(content)} />;
  } catch {
    return <p className="evidence-text">{content}</p>;
  }
}
