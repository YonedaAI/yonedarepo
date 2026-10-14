import { useRef, useState } from 'react';
import { guidedProfileId, guidedSteps } from '../../../../shared/guided-runs';
import { ApiError, api } from '../../lib/api';
import './guided-demo.css';
export function GuidedProject({
  onCreated,
  onClose,
}: {
  onCreated: (id: string, session?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('Guided demo');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const frozen = useRef<
    | {
        request_id: string;
        name: string;
        guided_profile_id: typeof guidedProfileId;
      }
    | undefined
  >(undefined);
  const pending = useRef(false);
  return (
    <section className="workspace-panel">
      <h2>A fresh guided task board</h2>
      <p>
        Create a separate project, then start each stage when you are ready. Your existing projects
        and connections are preserved.
      </p>
      <ol>
        {guidedSteps.map((step) => (
          <li key={step.id}>
            <strong>{step.title}</strong>
            <p>{step.description}</p>
          </li>
        ))}
      </ol>
      <p>
        Uses your connected models with automatic roles. Creating this project does not start agent
        work.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current) return;
          const title = name.trim();
          if (!title || new TextEncoder().encode(title).length > 100) {
            setError('Choose a project name of 1–100 bytes.');
            return;
          }
          pending.current = true;
          setBusy(true);
          setError('');
          frozen.current ??= {
            request_id: crypto.randomUUID(),
            name: title,
            guided_profile_id: guidedProfileId,
          };
          try {
            const result = await api<{ id: string; guided_session_id?: string }>(
              'projects',
              frozen.current,
            );
            if (typeof result.id !== 'string' || !result.id)
              throw new Error(
                'Project setup could not be confirmed. Retry this request to check its status.',
              );
            await onCreated(result.id, result.guided_session_id);
          } catch (failure) {
            if (
              failure instanceof ApiError &&
              !['REQUEST_TIMEOUT', 'REQUEST_FAILED'].includes(failure.code)
            )
              frozen.current = undefined;
            setError((failure as Error).message);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <label>
          Project name
          <input
            required
            name="name"
            maxLength={100}
            value={name}
            disabled={busy || !!frozen.current}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="run-actions">
          <button className="quiet" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy
              ? 'Creating your project…'
              : frozen.current
                ? 'Check project setup'
                : 'Create guided demo'}
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
