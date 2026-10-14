import { short } from '../../lib/api';
import type { SourceSelection } from '../../lib/sourceWorkspace';

export function SourceVersionBadge({ source }: { source: SourceSelection }) {
  const revision = source.kind === 'proposed' ? source.base : source.revision;
  const labels = {
    proposed: 'Proposed changes — not checked or published',
    captured: 'Captured source — inspect its recorded checks',
    checked: 'Checked source — publication is a separate decision',
    published: 'Published source — canonical Git revision recorded',
  };
  return (
    <header className="source-version">
      <h3>{labels[source.kind]}</h3>
      <p>
        {source.kind === 'proposed'
          ? `Change set version ${source.workspace_version} · based on `
          : 'Exact revision '}
        <code>{short(revision.commit)}</code>
      </p>
      <details>
        <summary>Exact source version</summary>
        <dl>
          <dt>Revision</dt>
          <dd>
            <code>{revision.commit}</code>
          </dd>
          <dt>Git tree</dt>
          <dd>
            <code>{revision.tree ?? 'Not supplied in the selected metadata'}</code>
          </dd>
          {source.kind === 'proposed' && (
            <>
              <dt>Source workspace</dt>
              <dd>
                <code>{source.workspace_id}</code>
              </dd>
              <dt>Attempt</dt>
              <dd>{source.epoch}</dd>
              <dt>Change set version</dt>
              <dd>{source.workspace_version}</dd>
            </>
          )}
          {source.kind === 'checked' && (
            <>
              <dt>Evaluation</dt>
              <dd>{source.evaluation_id}</dd>
              <dt>Recorded check policy</dt>
              <dd>{source.policy_version}</dd>
            </>
          )}
        </dl>
      </details>
    </header>
  );
}
