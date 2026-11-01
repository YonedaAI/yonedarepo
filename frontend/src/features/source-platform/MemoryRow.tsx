// One memory in the Memories list: its kind, text, anchors and origin, and for a writer the
// actions on it (publish or supersede through the composer, retire or discard).
import { useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { ComposerStart } from './MemoryComposer';
import { anchorText, type Memory } from './memoryModel';
import { usePeople } from './people';
import { useReadOnly } from './repoAccess';
import { shortSha, sourceApi, when } from './sourceApi';

function Retire({ repo, memory, onDone }: { repo: string; memory: Memory; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  if (!open)
    return (
      <button type="button" className="quiet" onClick={() => setOpen(true)}>
        {memory.status === 'draft' ? 'Discard…' : 'Retire…'}
      </button>
    );
  async function retire() {
    setError('');
    try {
      await sourceApi(`/repos/${repo}/memories/${memory.id}/retire`, {
        body: { reason: reason.trim() || null },
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <span className="memory-retire">
      <input
        aria-label={`Why memory #${memory.id} no longer holds`}
        placeholder="Why it no longer holds (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" onClick={retire}>
        Retire #{memory.id}
      </button>
      <button type="button" className="quiet" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && (
        <span role="alert" className="source-error">
          {error}
        </span>
      )}
    </span>
  );
}

export function MemoryRow({
  repo,
  memory: m,
  navigate,
  onEdit,
  onChanged,
}: {
  repo: string;
  memory: Memory;
  navigate: Navigate;
  onEdit: (start: ComposerStart) => void;
  onChanged: () => void;
}) {
  const people = usePeople();
  const readOnly = useReadOnly();
  const live = (m.status === 'active' || m.status === 'draft') && !m.quarantined;
  return (
    <li id={`memory-${m.id}`}>
      <div className="memory-chips">
        <span className="chip">{m.kind}</span>
        {m.status !== 'active' && <span className={`chip memory-${m.status}`}>{m.status}</span>}
        {m.stale && <span className="chip memory-stale">stale: the code changed since</span>}
      </div>
      {m.quarantined ? (
        <p className="source-meta">Withheld by the repository's owner.</p>
      ) : (
        <p className="memory-text">{m.text}</p>
      )}
      {m.anchors.length > 0 && (
        <ul className="memory-anchors" aria-label={`Anchors of memory #${m.id}`}>
          {m.anchors.map((a) => (
            <li key={anchorText(a)}>
              <a
                {...linkTo(
                  { view: 'files', repo, path: a.path.replace(/\/$/, ''), ref: 'main' },
                  navigate,
                )}
              >
                <code>{anchorText(a)}</code>
              </a>
              {a.stale === true && <span className="source-meta"> · changed since</span>}
            </li>
          ))}
        </ul>
      )}
      <span className="source-meta">
        #{m.id} · {people.principal(m.author)} · {when(m.recorded_at)} · against{' '}
        <a {...linkTo({ view: 'commit', repo, commit: m.commit }, navigate)}>
          <code>{shortSha(m.commit)}</code>
        </a>
        {m.session_id && (
          <>
            {' '}
            · session <code>{m.session_id}</code>
          </>
        )}
        {m.supersedes && <> · replaces #{m.supersedes}</>}
        {m.superseded_by && <> · replaced by #{m.superseded_by}</>}
        {m.retired && (
          <>
            {' '}
            · retired by {people.principal(m.retired.by)} {when(m.retired.at)}
            {m.retired.reason ? `: ${m.retired.reason}` : ''}
          </>
        )}
      </span>
      {!readOnly && live && (
        <div className="memory-actions">
          <button
            type="button"
            className="quiet"
            onClick={() =>
              onEdit({
                kind: m.kind,
                text: m.text ?? '',
                anchors: m.anchors.map(anchorText).join(', '),
                supersedes: m.id,
                publish: m.status === 'draft',
              })
            }
          >
            {m.status === 'draft' ? 'Publish…' : 'Supersede…'}
          </button>
          <Retire repo={repo} memory={m} onDone={onChanged} />
        </div>
      )}
    </li>
  );
}
