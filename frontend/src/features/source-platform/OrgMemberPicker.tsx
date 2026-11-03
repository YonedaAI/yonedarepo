// Search suggestions are owner-scoped; choosing one does not grant membership.
import { useEffect, useId, useRef, useState } from 'react';
import { normalizeAccountIdentifier, normalizeHandle } from '../../../../shared/account';
import { sourceApi } from './sourceApi';

export type OrgMemberCandidate = { identifier: string; handle: string | null; member: boolean };
type Results = {
  query: string;
  state: 'loading' | 'ready' | 'error';
  candidates: OrgMemberCandidate[];
};

export function OrgMemberPicker({
  org,
  value,
  selected,
  disabled,
  onChange,
  onSelect,
}: {
  org: string;
  value: string;
  selected: OrgMemberCandidate | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onSelect: (candidate: OrgMemberCandidate) => void;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [retry, setRetry] = useState(0);
  const [results, setResults] = useState<Results | null>(null);
  const query = value.trim();
  const text = query.startsWith('@') ? query.slice(1) : query;
  const valid = Boolean(
    text.includes('@') ? normalizeAccountIdentifier(text) : normalizeHandle(text),
  );
  const expanded = open && valid && !selected && !disabled;
  // A changed query hides the preceding result immediately, before effects run.
  const current = results?.query === query ? results : null;
  const candidates = current?.candidates ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry repeats the same query after a failed read.
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let current = true;
    setResults({ query, state: 'loading', candidates: [] });
    const timer = setTimeout(() => {
      void sourceApi<{ candidates: OrgMemberCandidate[] }>(
        `/orgs/${encodeURIComponent(org)}/member-candidates?q=${encodeURIComponent(query)}`,
        { signal: controller.signal, once: true },
      ).then(
        (data) => {
          if (current) setResults({ query, state: 'ready', candidates: data.candidates });
        },
        () => {
          if (current) setResults({ query, state: 'error', candidates: [] });
        },
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [expanded, org, query, retry]);

  useEffect(() => {
    if (expanded && active >= 0)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, expanded, listId]);

  function choose(candidate: OrgMemberCandidate | undefined) {
    if (!candidate || candidate.member) return;
    onSelect(candidate);
    setOpen(false);
    setActive(-1);
  }
  function move(direction: number) {
    setOpen(true);
    const start = active < 0 && direction < 0 ? candidates.length : active;
    for (let step = 1; step <= candidates.length; step++) {
      const next = (start + direction * step + candidates.length) % candidates.length;
      if (!candidates[next].member) {
        setActive(next);
        return;
      }
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: close only when focus leaves the composite search.
    <div
      className="source-field org-member-picker"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOpen(false);
        setActive(-1);
      }}
    >
      <label htmlFor={`${listId}-input`}>Account</label>
      <input
        ref={input}
        id={`${listId}-input`}
        role="combobox"
        value={value}
        disabled={disabled}
        placeholder="Handle or email"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && candidates[active] ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Enter') {
            // Enter chooses a suggestion; Add member is always a separate action.
            event.preventDefault();
            if (expanded) choose(candidates[active]);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {expanded && (
        <div className="org-member-suggestions">
          <div
            id={listId}
            role="listbox"
            aria-label="Matching accounts"
            aria-busy={!current || current.state === 'loading'}
          >
            {candidates.map((candidate, index) => (
              <div
                key={candidate.identifier}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={active === index}
                aria-disabled={candidate.member}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(candidate.member ? -1 : index)}
                onClick={() => choose(candidate)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    choose(candidate);
                  }
                }}
              >
                <span>{candidate.handle ? `@${candidate.handle}` : candidate.identifier}</span>
                {candidate.member && <span className="source-meta">Already a member</span>}
              </div>
            ))}
          </div>
          {(!current || current.state === 'loading') && <p role="status">Searching accounts…</p>}
          {current?.state === 'ready' && !candidates.length && (
            <p role="status">No matching account.</p>
          )}
          {current?.state === 'error' && (
            <div className="org-member-search-error" role="status">
              <span>Could not search accounts.</span>
              <button
                type="button"
                className="quiet"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  input.current?.focus();
                  setRetry((value) => value + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
