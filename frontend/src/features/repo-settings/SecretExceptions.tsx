// Secret exceptions: scan findings the owner accepted as false positives, by path (a file,
// or a directory ending in `/`) and rule. Every other credential is refused at commit.
import { useState } from 'react';
import { type Policy, SECRET_RULES, type SecretAllow } from './policy';

export function SecretExceptions({
  draft,
  change,
}: {
  draft: Policy;
  change: (next: Policy) => void;
}) {
  const allow = draft.secret_allow ?? [];
  const [path, setPath] = useState('');
  const [rule, setRule] = useState<string>(SECRET_RULES[0]);
  const set = (next: SecretAllow[]) => {
    const { secret_allow: _, ...rest } = draft;
    change(next.length ? { ...rest, secret_allow: next } : rest);
  };
  const exists = allow.some((a) => a.path === path.trim() && a.rule === rule);
  function add() {
    if (!path.trim() || exists) return;
    set([...allow, { path: path.trim(), rule }]);
    setPath('');
  }
  return (
    <>
      <p className="source-meta">
        A commit carrying a credential is refused before it is stored. List a finding here only when
        it is not a real secret (a test fixture, an example key in docs).
      </p>
      {allow.length === 0 ? (
        <p className="source-empty">No exceptions: every rule applies to every path.</p>
      ) : (
        <div className="source-table-wrap">
          <table className="source-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Rule</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {allow.map((a) => (
                <tr key={`${a.path}\0${a.rule}`}>
                  <td>
                    <code>{a.path}</code>
                  </td>
                  <td>{a.rule}</td>
                  <td>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => set(allow.filter((b) => b !== a))}
                    >
                      Remove {a.path}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <fieldset className="settings-add">
        <legend className="sr-only">Add an exception</legend>
        <label className="source-field">
          Path
          <input
            value={path}
            placeholder="tests/fixtures/ or docs/example.md"
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </label>
        <label className="source-field">
          Rule
          <select value={rule} onChange={(e) => setRule(e.target.value)}>
            {SECRET_RULES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="quiet" disabled={!path.trim() || exists} onClick={add}>
          Add exception
        </button>
      </fieldset>
    </>
  );
}
