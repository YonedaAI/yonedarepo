// Branches and tags (under History): create a working branch from another branch, delete one
// (never `main`), and create a tag (annotated with a message) on a branch's commit. Git pushes
// do the same; this is the browser's way. Only the write role and above see the controls.
// Each change shows at once from its own answer; the refs are read again at the change's
// version (`min_version`), and once more after the read bound while a read still predates it.
import { type FormEvent, useEffect, useState } from 'react';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { shortSha, sourceApi } from '../source-platform/sourceApi';
import { useChange } from '../source-platform/useChange';
import { type Loaded, useSource } from '../source-platform/useSource';
import {
  branchRows,
  createBranchBody,
  createdEdit,
  createTagBody,
  deleteBranchBody,
  deletedEdit,
  PROTECTED_BRANCH,
  pendingEdits,
  READ_LAG_MS,
  type RefEdit,
  type RefRow,
  type RefsAnswer,
  refNameProblem,
  tagRows,
  withEdits,
} from './refModel';

type Refs = Loaded<RefsAnswer>;

/** The repository's refs with this viewer's own changes applied until a read includes them.
 * `record` takes a change's edit; the refs are then read at its version or newer. */
function useEditedRefs(repo: string) {
  // Kept with the repository they were made in, so another repository starts clean.
  const [made, setMade] = useState<{ repo: string; edits: RefEdit[] }>({ repo, edits: [] });
  const edits = made.repo === repo ? made.edits : [];
  const floor = Math.max(0, ...edits.map((e) => e.version));
  const read = useSource<RefsAnswer>(`/repos/${repo}/refs${floor ? `?min_version=${floor}` : ''}`);
  const behind = pendingEdits(read.data, edits).length > 0;
  const { loading, error, reload } = read;
  // A read that still predates an edit (a platform without `min_version`) is retried once
  // the read bound has passed; a failed read waits for the viewer's Retry.
  useEffect(() => {
    if (!behind || loading || error) return;
    const timer = setTimeout(reload, READ_LAG_MS);
    return () => clearTimeout(timer);
  }, [behind, loading, error, reload]);
  const refs: Refs = { ...read, data: withEdits(read.data, edits) };
  const record = (edit: RefEdit | null) => {
    if (edit) setMade((m) => ({ repo, edits: [...(m.repo === repo ? m.edits : []), edit] }));
  };
  return { refs, record };
}

export function BranchTable({
  refs,
  onDelete,
}: {
  refs: Refs;
  /** Absent for viewers who may not delete branches. */
  onDelete?: (row: RefRow) => void;
}) {
  if (refs.loading && !refs.data) return <Loading what="branches" />;
  if (refs.error) return <Failure error={refs.error} onRetry={refs.reload} />;
  const rows = branchRows(refs.data?.refs);
  if (rows.length === 0) return <p className="source-empty">No branches yet.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table" aria-label="Branches">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Commit</th>
            {onDelete && (
              <th>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.name}>
              <td>{b.name}</td>
              <td>
                <code>{shortSha(b.commit)}</code>
              </td>
              {onDelete && (
                <td>
                  {b.name === PROTECTED_BRANCH ? (
                    <span className="source-meta">protected</span>
                  ) : (
                    <button
                      type="button"
                      className="quiet"
                      aria-label={`Delete branch ${b.name}`}
                      onClick={() => onDelete(b)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TagTable({ refs }: { refs: Refs }) {
  if (!refs.data) return null;
  const rows = tagRows(refs.data.refs);
  if (rows.length === 0) return <p className="source-empty">No tags yet.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table" aria-label="Tags">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Object</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.name}>
              <td>{t.name}</td>
              <td>
                <code>{shortSha(t.commit)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A name input with git's ref-name rules shown inline. */
function RefName({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const problem = value ? refNameProblem(value) : '';
  return (
    <label htmlFor={id} className="source-field">
      {label}
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        required
      />
      {problem && (
        <span id={`${id}-problem`} className="form-error">
          {problem}
        </span>
      )}
    </label>
  );
}

/** The branch to start from, as a select over the current branches. */
function StartFrom({
  id,
  branches,
  value,
  onChange,
}: {
  id: string;
  branches: RefRow[];
  value: string;
  onChange: (branch: string) => void;
}) {
  return (
    <label htmlFor={id} className="source-field">
      From branch
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {branches.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name} ({shortSha(b.commit)})
          </option>
        ))}
      </select>
    </label>
  );
}

export function RepoBranches({ repo, canWrite }: { repo: string; canWrite: boolean }) {
  const { refs, record } = useEditedRefs(repo);
  const { busy, error, run } = useChange(refs.reload);
  const [branch, setBranch] = useState('');
  const [branchFrom, setBranchFrom] = useState(PROTECTED_BRANCH);
  const [tag, setTag] = useState('');
  const [tagFrom, setTagFrom] = useState(PROTECTED_BRANCH);
  const [message, setMessage] = useState('');
  const branches = branchRows(refs.data?.refs);
  const commitOf = (name: string) => branches.find((b) => b.name === name)?.commit;
  // A chosen branch that is gone (or a missing main) falls back to the first one listed.
  const pick = (name: string) => (commitOf(name) ? name : (branches[0]?.name ?? ''));

  async function createBranch(event: FormEvent) {
    event.preventDefault();
    const commit = commitOf(pick(branchFrom));
    if (!commit) return;
    const body = createBranchBody(branch, commit);
    const create = () => sourceApi(`/repos/${repo}/branches`, { body }).then(createdEdit);
    if (await run(() => create().then(record))) setBranch('');
  }
  async function createTag(event: FormEvent) {
    event.preventDefault();
    const commit = commitOf(pick(tagFrom));
    if (!commit) return;
    const body = createTagBody(tag, commit, message);
    const create = () => sourceApi(`/repos/${repo}/tags`, { body }).then(createdEdit);
    if (await run(() => create().then(record))) {
      setTag('');
      setMessage('');
    }
  }
  function remove(row: RefRow) {
    if (!window.confirm(`Delete branch ${row.name}?`)) return;
    const body = deleteBranchBody(row);
    void run(() =>
      sourceApi(`/repos/${repo}/refs/batch`, { body }).then((answer) =>
        record(deletedEdit(row, answer)),
      ),
    );
  }

  const canStart = canWrite && branches.length > 0;
  return (
    <section aria-labelledby="branches-heading">
      <h2 id="branches-heading">Branches and tags</h2>
      <p className="source-meta">
        Working branches move freely; <code>{PROTECTED_BRANCH}</code> moves only by landing. Tags
        never move once created.
        {!canWrite && ' Creating and deleting them needs the write role.'}
      </p>
      <BranchTable refs={refs} onDelete={canWrite ? remove : undefined} />
      {canStart && (
        <form onSubmit={createBranch} className="source-token-form" aria-label="Create a branch">
          <RefName
            id="branch-name"
            label="New branch"
            value={branch}
            onChange={setBranch}
            placeholder="feature/login"
          />
          <StartFrom
            id="branch-from"
            branches={branches}
            value={pick(branchFrom)}
            onChange={setBranchFrom}
          />
          <button type="submit" disabled={busy || !branch || Boolean(refNameProblem(branch))}>
            Create branch
          </button>
        </form>
      )}
      <h3>Tags</h3>
      <TagTable refs={refs} />
      {canStart && (
        <form onSubmit={createTag} className="source-token-form" aria-label="Create a tag">
          <RefName
            id="tag-name"
            label="New tag"
            value={tag}
            onChange={setTag}
            placeholder="v1.0.0"
          />
          <StartFrom
            id="tag-from"
            branches={branches}
            value={pick(tagFrom)}
            onChange={setTagFrom}
          />
          <label htmlFor="tag-message" className="source-field settings-wide">
            Message (optional: makes an annotated tag)
            <input
              id="tag-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={8000}
            />
          </label>
          <button type="submit" disabled={busy || !tag || Boolean(refNameProblem(tag))}>
            Create tag
          </button>
        </form>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
