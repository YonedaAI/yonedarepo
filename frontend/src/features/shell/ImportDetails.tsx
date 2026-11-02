// The lower half of the import dialog: what a typed address still needs. A repository picked from
// the list needs none of it.
import { REPO_NAME_PATTERN } from './NewRepositoryDialog';
import { VisibilityField } from './repoFormFields';
import type { PlatformRepo } from './repoRows';

export function ImportDetails({
  name,
  onName,
  onlyPrivate,
  taken,
  error,
  busy,
  onOpen,
  onClose,
}: {
  name: string;
  onName: (name: string) => void;
  /** The source is private, so this copy can only be. */
  onlyPrivate?: boolean;
  /** The owner's repository that already has this name. */
  taken?: PlatformRepo;
  error: string;
  busy: boolean;
  onOpen?: (repo: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <label>
        Repository name
        <input
          name="name"
          required
          maxLength={100}
          pattern={REPO_NAME_PATTERN}
          title="Letters, digits, . _ and -; not starting with a dot"
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="my-service"
          autoComplete="off"
          disabled={busy}
        />
      </label>
      {taken && (
        <p role="status" className="source-meta github-repo-taken">
          You already have {taken.name}.{' '}
          <button type="button" onClick={() => onOpen?.(taken.id)}>
            Open it
          </button>{' '}
          or choose another name.
        </p>
      )}
      <VisibilityField disabled={busy} onlyPrivate={onlyPrivate} />
      <details className="source-details">
        <summary>Branch (optional)</summary>
        <label>
          Branch to import
          <input
            name="branch"
            maxLength={255}
            placeholder="The repository's default branch"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            disabled={busy}
          />
        </label>
      </details>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="new-repository-actions">
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={busy || Boolean(taken)}>
          {busy ? 'Adding…' : 'Add repository'}
        </button>
      </div>
    </>
  );
}
