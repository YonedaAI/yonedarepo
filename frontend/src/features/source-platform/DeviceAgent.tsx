// A device approval when an agent asks (`yoneda login --agent <name>`): who is asking, what it
// may do and where. An agent starts with reading and writing, on no repository, until the person
// chooses; it holds repository work only, so Admin and SSH keys are not offered.
import { PAT_SCOPES, type PatScope } from './connect';
import { ExpirySelect, type RepoSummary, ScopeChecks } from './TokenParts';

const AGENT_SCOPES = PAT_SCOPES.filter(
  (o) => o.scope.startsWith('repo:') && o.scope !== 'repo:admin',
);
export const AGENT_DEFAULT_SCOPES: PatScope[] = ['repo:read', 'repo:write'];

export type AgentForm = { scopes: PatScope[]; days: number; all: boolean; repos: string[] };

/** The form's first problem, shown as a hint, or '' when it can be approved. */
export function agentProblem(form: AgentForm) {
  if (form.scopes.length === 0) return 'Choose what access it has.';
  if (!form.all && form.repos.length === 0)
    return 'Choose at least one repository, or all repositories.';
  return '';
}

/** What approving sends: the chosen repositories, or all of them by name. */
export const agentGrant = (form: AgentForm) => ({
  scopes: form.scopes,
  expires_days: form.days,
  ...(form.all ? { all_repos: true } : { repos: form.repos }),
});

function AgentRepos({
  repos,
  form,
  onChange,
}: {
  repos: RepoSummary[];
  form: AgentForm;
  onChange: (next: Partial<AgentForm>) => void;
}) {
  return (
    <fieldset className="source-checks">
      <legend>Repositories</legend>
      <label>
        <input
          type="radio"
          name="agent-repos"
          checked={!form.all}
          onChange={() => onChange({ all: false })}
        />
        Only the ones I choose
      </label>
      <label>
        <input
          type="radio"
          name="agent-repos"
          checked={form.all}
          onChange={() => onChange({ all: true })}
        />
        All repositories, including ones created later
      </label>
      {repos.length === 0 && <p className="source-empty">No repositories yet.</p>}
      {!form.all &&
        repos.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={form.repos.includes(r.id)}
              onChange={(e) =>
                onChange({
                  repos: e.target.checked
                    ? [...form.repos, r.id]
                    : form.repos.filter((id) => id !== r.id),
                })
              }
            />
            {r.name}
          </label>
        ))}
    </fieldset>
  );
}

export function AgentFields({
  agent,
  host,
  repos,
  form,
  onChange,
}: {
  agent: string;
  host?: string | null;
  repos: RepoSummary[];
  form: AgentForm;
  onChange: (next: Partial<AgentForm>) => void;
}) {
  const problem = agentProblem(form);
  return (
    <>
      <p>
        Agent <strong>{agent}</strong>
        {host && ` on ${host}`} is asking to work in your account.
      </p>
      <ScopeChecks
        legend="Access"
        options={AGENT_SCOPES}
        value={form.scopes}
        onChange={(scopes) => onChange({ scopes })}
      />
      <ExpirySelect id="device-expiry" value={form.days} onChange={(days) => onChange({ days })} />
      <AgentRepos repos={repos} form={form} onChange={onChange} />
      {problem && <p className="source-meta">{problem}</p>}
    </>
  );
}
