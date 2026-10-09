import { short } from '../../lib/api';
import type { TeamRecord } from './teamView';
export function IntegrationInputs({
  candidate,
  onInspectTask,
}: {
  candidate: TeamRecord;
  onInspectTask: (id: string) => void;
}) {
  const manifest = candidate.integration_manifest;
  if (!manifest)
    return (
      <p className="subtle">
        The integration input manifest is not available for this candidate. Source identity must be
        verified before publication.
      </p>
    );
  return (
    <details className="team-contract">
      <summary>Included task revisions</summary>
      <p>
        Frozen plan revision {manifest.plan_revision}. The trusted final capture is bound to these
        exact specialist outputs.
      </p>
      <ul>
        {(manifest.inputs ?? []).map((input: TeamRecord) => (
          <li key={input.task_id}>
            <button
              type="button"
              className="text-button"
              onClick={() => onInspectTask(input.task_id)}
            >
              {input.task_id}
            </button>{' '}
            · task version {input.task_revision} · <code>{short(input.revision?.commit)}</code> ·{' '}
            {(input.paths ?? []).length} changed paths
          </li>
        ))}
      </ul>
      <p>
        Manifest <code>{short(candidate.integration_digest)}</code>
      </p>
    </details>
  );
}
