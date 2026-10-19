export function Loading({ what }: { what: string }) {
  return (
    <p className="source-empty" aria-busy="true">
      Loading {what}…
    </p>
  );
}

export function Failure({ error, onRetry }: { error: string; onRetry?: () => void }) {
  if (/Sign in/.test(error))
    return (
      <div role="alert" className="source-error">
        <span>
          You are signed out. <a href="/">Sign in from the workspace</a>, then return here.
        </span>
      </div>
    );
  return (
    <div role="alert" className="source-error">
      <span>{error}</span>
      {onRetry && (
        <button type="button" className="quiet" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
