import type { GraphNode } from '../../lib/types';
import { contextAuthority, contextBody, contextPaths, contextText } from './frozenContextView';

export function ContextRecordBody({ record }: { record: GraphNode }) {
  const paths = contextPaths(record);
  return (
    <>
      <p className="prior-context-authority">
        {record.kind.replaceAll('_', ' ')} · {contextAuthority(record.kind)}
        {record.author && (
          <>
            {' '}
            · Recorded by <span>{record.author}</span>
          </>
        )}
      </p>
      <p className="prior-context-statement">
        {contextBody(record) || 'Statement unavailable in this record.'}
      </p>
      {contextText(record.data.purpose) && (
        <p className="prior-context-purpose">
          <strong>Recorded purpose:</strong> {record.data.purpose}
        </p>
      )}
      {paths.length > 0 && (
        <div className="prior-context-paths">
          <strong>Referenced source paths (assertions)</strong>
          <ul>
            {paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <small className="prior-context-id">
        Record <code>{record.id}</code>
      </small>
    </>
  );
}
