import { referenceOf, SERVER_FAILURE } from './sourceApi';

export function Loading({ what }: { what: string }) {
  return (
    <p className="source-empty" aria-busy="true">
      Loading {what}…
    </p>
  );
}

/** A failure as people read it: a server-side fault (or a raw platform error that reached
 * here) becomes "Couldn't load …" with its reference set apart; other messages stay. */
export function describeFailure(error: string, what?: string) {
  const reference = referenceOf(error);
  const server =
    error.startsWith(SERVER_FAILURE) ||
    Boolean(reference) ||
    /\b[A-Z][A-Z0-9]*_ERROR\b|internal error|OVERLOADED/.test(error);
  if (!server) return { text: error, reference: undefined };
  return { text: what ? `Couldn't load ${what}.` : SERVER_FAILURE, reference };
}

export function Failure({
  error,
  onRetry,
  what,
}: {
  error: string;
  onRetry?: () => void;
  /** What failed to load ("your repositories"), for a server-side fault. */
  what?: string;
}) {
  if (/Sign in/.test(error))
    return (
      <div role="alert" className="source-error">
        <span>
          You are signed out. <a href="/">Sign in from the workspace</a>, then return here.
        </span>
      </div>
    );
  const shown = describeFailure(error, what);
  return (
    <div role="alert" className="source-error">
      <span>
        {shown.text}
        {shown.reference && (
          <small className="failure-reference">Reference {shown.reference}</small>
        )}
      </span>
      {onRetry && (
        <button type="button" className="quiet" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
