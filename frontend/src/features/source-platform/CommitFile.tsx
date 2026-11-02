// Add or edit one file from the Files page. The commit lands on a working branch: the one on
// screen, or a new one when the page shows main, which moves only by landing.
import { type FormEvent, useState } from 'react';
import { CodeBlock } from './CodeBlock';
import { FileHeader } from './FileHeader';
import {
  branchFor,
  type CommitPlace,
  type Committed,
  commitFile,
  commitFileFailure,
  draftProblem,
} from './fileCommit';
import { Failure } from './SourceStatus';

const staysOn = (branch: string) => branch !== 'main' && !branch.startsWith('release');

export function CommitFile({
  repo,
  place,
  dir,
  editing,
  onCancel,
  onCommitted,
}: {
  repo: string;
  place: CommitPlace;
  /** The folder on screen, where a new file starts. */
  dir: string;
  editing?: { path: string; content: string };
  onCancel: () => void;
  onCommitted: (done: Committed, path: string) => void;
}) {
  const [path, setPath] = useState(editing?.path ?? (dir ? `${dir}/` : ''));
  const [content, setContent] = useState(editing?.content ?? '');
  // Both follow the file's name until they are typed in.
  const [typedMessage, setMessage] = useState<string | null>(null);
  const [typedBranch, setBranch] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const message = typedMessage ?? (path ? `${editing ? 'Update' : 'Add'} ${path}` : '');
  const branch = typedBranch ?? (staysOn(place.from) ? place.from : branchFor(path));
  const draft = { path, content, message, branch, goal };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = draftProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    try {
      onCommitted(await commitFile(repo, draft, place), path);
    } catch (e) {
      setError(commitFileFailure(e, place, branch));
      setBusy(false);
    }
  }

  // In the header, which stays on screen, so a long file never hides them.
  const actions = (
    <>
      <button type="button" className="quiet" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </>
  );

  return (
    <form
      className="source-token-form source-open-change source-commit-file"
      onSubmit={submit}
      aria-label={editing ? `Edit ${editing.path}` : 'Add a file'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="source-file code-editor">
        <div className="code-editor-top">
          {editing ? (
            <FileHeader path={editing.path}>{actions}</FileHeader>
          ) : (
            <header className="file-header">
              <label className="source-field">
                File
                <input
                  value={path}
                  required
                  placeholder="src/app.ts"
                  spellCheck={false}
                  // biome-ignore lint/a11y/noAutofocus: the form opens because the user asked for it.
                  autoFocus
                  onChange={(e) => setPath(e.target.value)}
                />
              </label>
              <span className="file-actions">{actions}</span>
            </header>
          )}
          {error && <Failure error={error} />}
        </div>
        <CodeBlock value={content} path={path} label="Contents" onChange={setContent} />
      </div>
      <div className="code-editor-fields">
        <label className="source-field code-editor-message">
          Commit message
          <input value={message} required onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label className="source-field">
          Branch
          <input
            value={branch}
            required
            spellCheck={false}
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <label className="source-field">
          Flight plan
          <input
            value={goal}
            maxLength={2000}
            placeholder="What this work sets out to do"
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
      </div>
    </form>
  );
}
