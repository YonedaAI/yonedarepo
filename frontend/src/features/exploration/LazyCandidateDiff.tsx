import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { CandidateSourcePreview } from './CandidateSourcePreview';
import { SourceDiff } from './SourceDiff';

interface DiffState {
  identity: string;
  value: string | null;
}
interface DiffError {
  identity: string;
  message: string;
}

export function LazyCandidateDiff({
  repo,
  candidate,
}: {
  repo: string;
  candidate: Record<string, any>;
}) {
  const [open, setOpen] = useState(false);
  const identity = JSON.stringify([repo, candidate.id, candidate.revision?.commit]);
  const [diffState, setDiffState] = useState<DiffState>({
    identity,
    value: typeof candidate.diff === 'string' ? candidate.diff : null,
  });
  const [errorState, setErrorState] = useState<DiffError | null>(null);
  const [retry, setRetry] = useState(0);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const diff =
    diffState.identity === identity
      ? diffState.value
      : typeof candidate.diff === 'string'
        ? candidate.diff
        : null;
  const error = errorState?.identity === identity ? errorState.message : '';

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry restarts a failed read for this identity.
  useEffect(() => {
    if (!open || diff !== null) return;
    let current = true;
    const isCurrent = () => current && identityRef.current === identity;
    setErrorState(null);
    const candidateId = candidate.id;
    if (typeof candidateId !== 'string') {
      setErrorState({ identity, message: 'The captured candidate identity is incomplete.' });
      return;
    }
    void api<Record<string, any>>(
      `repos/${repo}/candidate?${new URLSearchParams({ id: candidateId })}`,
    )
      .then((result) => {
        if (!result || result.id !== candidateId || typeof result.diff !== 'string')
          throw new Error('The captured diff could not be verified.');
        if (isCurrent()) setDiffState({ identity, value: result.diff });
      })
      .catch((reason: unknown) => {
        if (isCurrent())
          setErrorState({
            identity,
            message:
              reason instanceof Error ? reason.message : 'The captured diff could not be read.',
          });
      });
    return () => {
      current = false;
    };
  }, [open, diff, retry, repo, candidate.id, candidate.revision?.commit, identity]);

  const patchRecorded =
    diff?.split(/\r?\n/).some((line) => line.startsWith('diff --git ')) ?? false;
  return (
    <>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{patchRecorded || diff === null ? 'Review changes' : 'Change summary'}</summary>
        {diff !== null && !patchRecorded ? (
          <>
            <p>
              This historical capture records change statistics only; the patch was not recorded.
            </p>
            <pre>{diff || 'No change summary was recorded.'}</pre>
          </>
        ) : diff !== null ? (
          <SourceDiff diff={diff} />
        ) : error ? (
          <div role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              Retry diff
            </button>
          </div>
        ) : (
          <p role="status">Loading captured diff…</p>
        )}
      </details>
      <CandidateSourcePreview repo={repo} candidate={candidate} />
    </>
  );
}
