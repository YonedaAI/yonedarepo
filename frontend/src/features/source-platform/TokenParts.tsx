// Shared pieces of the token, device and connect views: copyable snippets, the one-time
// token display and the scope, expiry and repository pickers.
import { useState } from 'react';
import { EXPIRY_DAYS } from './connect';

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="source-copy">
      <div className="source-copy-head">
        <span>{label}</span>
        <button type="button" className="quiet" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A newly created secret: shown once, with a copy action; the server keeps only its hash. */
export function ShownOnce({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <div className="source-shown-once" role="status">
      <strong>Copy this token now. It will not be shown again.</strong>
      <CopyBlock label="token" text={token} />
      <p className="source-meta">
        Keep it in your password manager or the YONEDA_TOKEN environment variable, never in a file,
        URL or prompt.
      </p>
      <button type="button" onClick={onDone}>
        I saved it
      </button>
    </div>
  );
}

export function ScopeChecks<S extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly { scope: S; label: string; hint?: string }[];
  value: S[];
  onChange: (next: S[]) => void;
}) {
  return (
    <fieldset className="source-checks">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.scope}>
          <input
            type="checkbox"
            checked={value.includes(o.scope)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, o.scope] : value.filter((s) => s !== o.scope))
            }
          />
          {o.label}
          {o.hint && <span className="source-meta"> ({o.hint})</span>}
        </label>
      ))}
    </fieldset>
  );
}

export function ExpirySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (days: number) => void;
}) {
  return (
    <label htmlFor={id} className="source-field">
      Expires after
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {EXPIRY_DAYS.map((d) => (
          <option key={d} value={d}>
            {d === 1 ? '1 day' : `${d} days`}
          </option>
        ))}
      </select>
    </label>
  );
}

export type RepoSummary = { id: string; name: string; created_at?: number };

/** Optional repository allowlist: none selected means every repository. */
export function RepoAllowlist({
  repos,
  value,
  onChange,
}: {
  repos: RepoSummary[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="source-checks">
      <legend>Repositories</legend>
      <p className="source-meta">
        {value.length === 0 ? 'All repositories, including ones created later.' : 'Only these.'}
      </p>
      {repos.length === 0 && <p className="source-empty">No repositories yet.</p>}
      {repos.map((r) => (
        <label key={r.id}>
          <input
            type="checkbox"
            checked={value.includes(r.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, r.id] : value.filter((id) => id !== r.id))
            }
          />
          {r.name}
        </label>
      ))}
    </fieldset>
  );
}
