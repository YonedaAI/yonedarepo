// An organization's teams: owners create and delete them and add or remove org members.
// A repository grants a team a role as the member entry `team:<org>/<team>`; removing
// someone from a team ends that access within about a second.
import { type FormEvent, useState } from 'react';
import { addableTo, type Org, type Team, teamEntry, teamNameProblem } from './orgModel';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { useChange } from './useChange';

function TeamCard({
  org,
  team,
  addable,
  manages,
  busy,
  run,
}: {
  org: string;
  team: Team;
  addable: string[];
  manages: boolean;
  busy: boolean;
  run: (change: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [account, setAccount] = useState('');
  const base = `/orgs/${org}/teams/${encodeURIComponent(team.name)}`;
  const label = `team-${team.name}`;
  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(() => sourceApi(`${base}/members`, { body: { account } }))) setAccount('');
  }
  function remove(who: string) {
    if (!window.confirm(`Remove ${who} from ${team.name}? Access through it ends at once.`)) return;
    void run(() => sourceApi(`${base}/members/${encodeURIComponent(who)}`, { method: 'DELETE' }));
  }
  function drop() {
    if (!window.confirm(`Delete team ${team.name}? Its members lose access through it.`)) return;
    void run(() => sourceApi(base, { method: 'DELETE' }));
  }
  return (
    <li className="org-team">
      <h3 id={label}>
        {team.name} <code className="source-meta">{teamEntry(org, team.name)}</code>
      </h3>
      {team.members.length === 0 ? (
        <p className="source-empty">No members.</p>
      ) : (
        <ul className="org-team-members">
          {team.members.map((m) => (
            <li key={m}>
              {m}
              {manages && (
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Remove ${m} from ${team.name}`}
                  onClick={() => remove(m)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manages && (
        <div className="org-team-actions">
          <form onSubmit={add} className="source-token-form">
            <label className="source-field">
              Add member
              <select value={account} onChange={(e) => setAccount(e.target.value)} required>
                <option value="">
                  {addable.length ? 'Choose an org member' : 'Every org member is on it'}
                </option>
                {addable.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy || !account}>
              Add
            </button>
          </form>
          <button type="button" className="quiet" disabled={busy} onClick={drop}>
            Delete team
          </button>
        </div>
      )}
    </li>
  );
}

export function OrgTeams({
  org,
  data,
  manages,
  onChanged,
}: {
  org: string;
  data: Org;
  manages: boolean;
  onChanged: () => void;
}) {
  const { busy, error, run } = useChange(onChanged);
  const [name, setName] = useState('');
  const problem = name ? teamNameProblem(name) : '';
  async function create(event: FormEvent) {
    event.preventDefault();
    if (await run(() => sourceApi(`/orgs/${org}/teams`, { body: { name } }))) setName('');
  }
  const teams = [...data.teams].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section aria-labelledby="org-teams-heading">
      <h2 id="org-teams-heading">Teams</h2>
      <p className="source-meta">
        Give a team a role on a repository in its Members settings as{' '}
        <code>{teamEntry(org, '<team>')}</code>.
      </p>
      {teams.length === 0 ? (
        <p className="source-empty">No teams yet.</p>
      ) : (
        <ul className="org-teams">
          {teams.map((t) => (
            <TeamCard
              key={t.name}
              org={org}
              team={t}
              addable={addableTo(t, data.members)}
              manages={manages}
              busy={busy}
              run={run}
            />
          ))}
        </ul>
      )}
      {manages && (
        <form onSubmit={create} className="source-token-form">
          <label htmlFor="org-team-name" className="source-field">
            New team
            <input
              id="org-team-name"
              value={name}
              onChange={(e) => setName(e.target.value.trim())}
              placeholder="devs"
              autoComplete="off"
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'org-team-problem' : undefined}
              required
            />
          </label>
          <button type="submit" disabled={busy || !name || Boolean(problem)}>
            Create team
          </button>
          {problem && (
            <span id="org-team-problem" className="form-error">
              {problem}
            </span>
          )}
        </form>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
