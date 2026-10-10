import { GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Repository, SetupStage } from '../../lib/types';
import '../../styles/setup-progress.css';

const stages: Record<SetupStage, { label: string; detail: string }> = {
  queued: {
    label: 'Queued for setup',
    detail: 'Your repository setup is queued to run in the background.',
  },
  checking_remote: {
    label: 'Checking source repository',
    detail: 'Checking access and finding its default branch.',
  },
  creating: {
    label: 'Creating repository storage',
    detail: 'Preparing a home for your source in Cloudflare Artifacts.',
  },
  importing: { label: 'Importing source', detail: 'Copying the source into your repository.' },
  checking_source: {
    label: 'Checking source',
    detail: 'Confirming the imported branch contains a source commit.',
  },
  initializing: {
    label: 'Preparing your workspace',
    detail: 'Initializing repository state and the context graph.',
  },
  failed: { label: 'Setup stopped', detail: 'Review the error below, then retry setup.' },
  ready: { label: 'Repository ready', detail: 'Opening your source and recorded context.' },
};

export function SetupProgress({
  reviewer = false,
  project,
  error,
  onRetry,
  onRefresh,
}: {
  reviewer?: boolean;
  project: Repository;
  error: string;
  onRetry: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const failed = project.status === 'failed';
  const stalled = !failed && now - (project.updated_at ?? project.created_at ?? now) > 120_000;
  const stage = stages[failed ? 'failed' : (project.stage ?? 'queued')] ?? stages.queued;
  const started = project.setup_started_at;
  const until = failed ? (project.updated_at ?? now) : now;
  const elapsed =
    started && Number.isFinite(started) ? Math.max(0, Math.floor((until - started) / 1000)) : null;
  useEffect(() => {
    if (failed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [failed]);
  useEffect(() => {
    if (project.status !== 'failed') setActionError('');
  }, [project.status]);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await action();
    } catch (failure) {
      setActionError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="setup-progress" aria-labelledby="setup-title" aria-busy={busy}>
      <div className={`setup-symbol${failed ? ' setup-failed' : ''}`} aria-hidden="true">
        {failed ? <GitBranch size={27} /> : <LoaderCircle size={27} className="spin" />}
      </div>
      <h1 id="setup-title">
        {failed ? 'Repository setup needs attention' : `Preparing ${project.name}`}
      </h1>
      <div className="setup-stage" role="status">
        <strong>{stage.label}</strong>
        <p>{stage.detail}</p>
      </div>
      <dl className="setup-timing">
        {elapsed !== null && (
          <div>
            <dt>Elapsed</dt>
            <dd>
              {Math.floor(elapsed / 60)}m {elapsed % 60}s
            </dd>
          </div>
        )}
        {!!project.updated_at && (
          <div>
            <dt>Last update</dt>
            <dd>{new Date(project.updated_at).toLocaleTimeString()}</dd>
          </div>
        )}
      </dl>
      {failed && (
        <div className="setup-error" role="alert">
          <p>
            {project.error ||
              'Repository setup failed. Retry setup or check the source repository.'}
          </p>
          {project.error_code && (
            <small>
              Error code: <code>{project.error_code}</code>
            </small>
          )}
        </div>
      )}
      {(actionError || error) && (
        <p className="setup-error" role="alert">
          Could not update setup status: {actionError || error}
        </p>
      )}
      {!failed && (
        <p className="setup-note">
          Setup continues in the background. You can leave this page and return; status updates
          automatically.
        </p>
      )}
      {stalled && (
        <p className="setup-error" role="status">
          No recent setup status has arrived. Retry setup to resume it, or refresh to check again.
        </p>
      )}
      <div className="setup-actions">
        {!reviewer && (failed || stalled) && (
          <button type="button" disabled={busy} onClick={() => void act(onRetry)}>
            {busy ? 'Retrying…' : 'Retry setup'}
          </button>
        )}
        <button type="button" className="quiet" disabled={busy} onClick={() => void act(onRefresh)}>
          <RefreshCw size={15} />
          Refresh status
        </button>
      </div>
    </section>
  );
}
