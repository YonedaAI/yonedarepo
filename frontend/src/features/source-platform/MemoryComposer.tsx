// Writing a memory from the web: a new one, or one that supersedes (or, for a draft an
// agent's session offered, publishes) an existing memory. The kind comes from the repository's
// list or is named here, which adds it. The platform normalizes and validates a new kind,
// resolves the anchors at main's head, refuses a credential in the text, and decides who may
// write.
import { type FormEvent, useState } from 'react';
import {
  byteLength,
  kindOptions,
  MAX_MEMORY_BYTES,
  type MemoryKind,
  memoryBody,
} from './memoryModel';
import { sourceApi } from './sourceApi';

export type ComposerStart = {
  kind: MemoryKind;
  text: string;
  anchors: string;
  supersedes: number | null;
  /** Publishing a draft rather than superseding a memory. */
  publish?: boolean;
};

export const EMPTY_COMPOSER: ComposerStart = {
  kind: 'decision',
  text: '',
  anchors: '',
  supersedes: null,
};

/** The select's value for "New kind…": a kind is a word, so never a kind. */
const NEW_KIND = ' new';

export function MemoryComposer({
  repo,
  kinds,
  start,
  onSaved,
  onCancel,
}: {
  repo: string;
  /** The repository's kinds, once a read has answered them. */
  kinds?: readonly MemoryKind[];
  start: ComposerStart;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(start);
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bytes = byteLength(draft.text.trim());
  const tooLong = bytes > MAX_MEMORY_BYTES;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await sourceApi(`/repos/${repo}/memories`, { body: memoryBody(draft) });
      setDraft(EMPTY_COMPOSER);
      setNaming(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = start.supersedes
    ? start.publish
      ? `Publish draft #${start.supersedes}`
      : `Supersede memory #${start.supersedes}`
    : 'Add a memory';
  return (
    <form className="memory-composer" onSubmit={save} aria-label={title}>
      <h3>{title}</h3>
      <div className="memory-composer-row">
        <label className="agent-filter">
          Kind
          <select
            value={naming ? NEW_KIND : draft.kind}
            onChange={(e) => {
              const named = e.target.value === NEW_KIND;
              setNaming(named);
              setDraft({ ...draft, kind: named ? '' : e.target.value });
            }}
          >
            {kindOptions(kinds, naming ? '' : start.kind).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            <option value={NEW_KIND}>New kind…</option>
          </select>
        </label>
        {naming && (
          <label className="agent-filter">
            Name the kind
            <input
              value={draft.kind}
              required
              maxLength={32}
              size={16}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="runbook"
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            />
          </label>
        )}
        <label className="memory-anchors-input">
          Anchors
          <input
            value={draft.anchors}
            placeholder="src/net.rs#retry, docs/"
            onChange={(e) => setDraft({ ...draft, anchors: e.target.value })}
          />
        </label>
      </div>
      <label className="memory-text-input">
        What a later session should know
        <textarea
          value={draft.text}
          rows={4}
          required
          aria-describedby="memory-bytes"
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
      </label>
      <p id="memory-bytes" className={tooLong ? 'source-error' : 'source-meta'}>
        {bytes} / {MAX_MEMORY_BYTES} bytes · anchors are files, <code>path#symbol</code> or{' '}
        <code>dir/</code>, resolved at main's head
      </p>
      {error && (
        <p role="alert" className="source-error">
          {error}
        </p>
      )}
      <div className="memory-actions">
        <button
          type="submit"
          disabled={busy || tooLong || !draft.text.trim() || !draft.kind.trim()}
        >
          {busy ? 'Saving…' : start.publish ? 'Publish' : 'Save memory'}
        </button>
        {onCancel && (
          <button type="button" className="quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
