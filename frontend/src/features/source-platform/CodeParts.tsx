// The Code tab's toolbar and summary: branch and tag picker, Clone, and the latest commit.
import { CircleAlert, CircleCheck, CircleDashed, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CloneCommands } from './ConnectPanel';
import { ago } from './fileActivity';
import { usePeople } from './people';
import { Failure } from './SourceStatus';
import { shortSha } from './sourceApi';
import { type SshAccess, sshCloneCommand } from './sshKeyModel';
import { CopyBlock } from './TokenParts';
import { useSource } from './useSource';

type Ref = { name: string; commit_id: string };

/** Branches and tags; a tag's value is its full ref name. */
export function BranchPicker({
  refs,
  value,
  onChange,
}: {
  refs: Ref[];
  value: string;
  onChange: (ref: string) => void;
}) {
  const branches = refs.filter((r) => r.name.startsWith('refs/heads/'));
  const tags = refs.filter((r) => r.name.startsWith('refs/tags/'));
  const known = refs.some((r) => r.name === value || r.name === `refs/heads/${value}`);
  return (
    <label className="source-version">
      <span className="sr-only">Branch or tag</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Branch or tag">
        {!known && <option value={value}>{value}</option>}
        <optgroup label="Branches">
          {branches.map((r) => {
            const name = r.name.slice('refs/heads/'.length);
            return (
              <option key={r.name} value={name}>
                {name}
              </option>
            );
          })}
        </optgroup>
        {tags.length > 0 && (
          <optgroup label="Tags">
            {tags.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name.slice('refs/tags/'.length)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** The SSH clone line when Git over SSH is open, and on the Cloudflare Tunnel front door a
 * pointer to the one-time client setup (Settings → SSH keys); nothing while it is off. */
export function SshCloneLine({
  access,
  repo,
  name,
}: {
  access?: SshAccess;
  repo: string;
  name?: string;
}) {
  const command = sshCloneCommand(access, repo, name);
  if (!command) return null;
  return (
    <>
      <CopyBlock label="SSH" text={command} />
      {access?.front_door === 'tunnel' && (
        <p className="source-meta clone-hint">
          Needs cloudflared and an <code>~/.ssh/config</code> entry once:{' '}
          <a href="/settings#ssh-keys">Settings → SSH keys</a>.
        </p>
      )}
    </>
  );
}

/** Asks the platform how SSH is reached (only once the menu opens). */
function SshClone({ repo, name }: { repo: string; name?: string }) {
  const ssh = useSource<{ ssh?: SshAccess }>('/ssh-keys');
  return <SshCloneLine access={ssh.data?.ssh} repo={repo} name={name} />;
}

/** "Clone": whole `git clone` commands with copy buttons, each into a directory named after
 * the repository: the yoneda remote helper (recommended), HTTPS and SSH (when open). Until
 * the repository's name is known (its status still loading) no command is shown: one copied
 * then would clone into a directory named by the id. */
export function CloneButton({
  repo,
  name,
  origin,
}: {
  repo: string;
  name?: string;
  origin: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="clone-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary>
        <Copy size={15} aria-hidden="true" />
        Clone
      </summary>
      <div className="clone-dropdown">
        {name ? (
          <>
            <CloneCommands repo={repo} name={name} origin={origin} />
            {open && <SshClone repo={repo} name={name} />}
          </>
        ) : (
          <p className="source-meta">Loading the clone commands…</p>
        )}
      </div>
    </details>
  );
}

type Detail = {
  commit: string;
  message: string;
  principal: string;
  landings: { refname: string; landed_at: number }[];
  checks: { name: string; status: string }[];
  gates?: { missing_checks: string[]; failing_checks: string[] };
};

function ChecksState({ detail }: { detail: Detail }) {
  const failing = detail.gates?.failing_checks ?? [];
  const missing = detail.gates?.missing_checks ?? [];
  if (failing.length)
    return (
      <span className="source-check-fail">
        <CircleAlert size={14} aria-hidden="true" /> {failing.join(', ')} failing
      </span>
    );
  if (missing.length)
    return (
      <span className="source-meta">
        <CircleDashed size={14} aria-hidden="true" /> waiting for {missing.join(', ')}
      </span>
    );
  if (!detail.checks.length) return null;
  return (
    <span className="source-check-pass">
      <CircleCheck size={14} aria-hidden="true" /> {detail.checks.length} check
      {detail.checks.length === 1 ? '' : 's'} passed
    </span>
  );
}

/** The commit a listing shows: author, message, age, short id and its checks. */
export function LatestCommit({
  repo,
  commit,
  now = Date.now(),
  commitLink,
}: {
  repo: string;
  commit: string;
  now?: number;
  commitLink: (commit: string, children: ReactNode) => ReactNode;
}) {
  const people = usePeople();
  const detail = useSource<Detail>(`/repos/${repo}/commits/${commit}`);
  if (detail.error) return <Failure error={detail.error} onRetry={detail.reload} />;
  const d = detail.data;
  const landed = d?.landings[0]?.landed_at;
  return (
    <div className="latest-commit" aria-busy={!d || undefined}>
      {d ? (
        <>
          <strong>{people.principal(d.principal)}</strong>
          <span className="latest-message">{commitLink(commit, d.message.split('\n')[0])}</span>
          <ChecksState detail={d} />
        </>
      ) : (
        <span className="source-meta">Loading the latest commit…</span>
      )}
      <span className="latest-meta">
        {commitLink(commit, <code>{shortSha(commit)}</code>)}
        {landed && <time dateTime={new Date(landed).toISOString()}>{ago(landed, now)}</time>}
      </span>
    </div>
  );
}
