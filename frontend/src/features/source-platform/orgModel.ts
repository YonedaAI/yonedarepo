// Organizations as the API reports them, and the pure rules the org pages share: names,
// repository member entries for teams (`team:<org>/<team>`) and the owners a new
// repository may have. The server decides every change; these only shape the forms.
import { ORG_NAME } from './sourceRoute';

export { ORG_NAME };
export const TEAM_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ORG_ROLES = ['member', 'owner'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** `GET /orgs`: the caller's organizations and its role in each. */
export type OrgSummary = { org: string; role: OrgRole };
export type OrgMember = { account: string; role: OrgRole; added_by: string; added_at: number };
export type Team = { name: string; created_by: string; created_at: number; members: string[] };
/** `GET /orgs/:org`: `role` is the caller's. */
export type Org = {
  org: string;
  created_at: number;
  created_by: string;
  role: OrgRole;
  members: OrgMember[];
  teams: Team[];
};

export const ORG_ROLE_HELP: Record<OrgRole, string> = {
  member: 'repository access through teams',
  owner: 'also owns every repository and manages members and teams',
};

/** Why `name` is not an organization name, or '' when it is. */
export function orgNameProblem(name: string): string {
  return ORG_NAME.test(name)
    ? ''
    : '3–32 characters: a lowercase letter, then lowercase letters, digits or _';
}

/** Why `name` is not a team name, or '' when it is. */
export function teamNameProblem(name: string): string {
  return TEAM_NAME.test(name)
    ? ''
    : 'Up to 32 characters: lowercase letters, digits, _ and -, starting with a letter or digit';
}

/** The repository member entry that grants a role to a team. */
export const teamEntry = (org: string, team: string) => `team:${org}/${team}`;

/** The org and team of a repository member entry, or null for an account. */
export function teamOf(account: string): { org: string; team: string } | null {
  const match = /^team:([^/]+)\/([^/]+)$/.exec(account);
  return match ? { org: match[1], team: match[2] } : null;
}

/** Who may own a new repository: the caller's own account, then each org it owns. The
 * empty value is the caller (the API's default); only an org is sent as `owner`. */
export function ownerOptions(
  account: string | undefined,
  orgs: OrgSummary[],
): { value: string; label: string }[] {
  return [
    { value: '', label: account ? `${account} (you)` : 'Your account' },
    ...orgs
      .filter((o) => o.role === 'owner')
      .map((o) => o.org)
      .sort()
      .map((org) => ({ value: org, label: `${org} (organization)` })),
  ];
}

/** Org members not yet on `team`, for its add picker. */
export const addableTo = (team: Team, members: OrgMember[]) =>
  members.map((m) => m.account).filter((a) => !team.members.includes(a));

/** The repository member entry a members form names: an account as typed, or a team as
 * `org/team` (with or without the `team:` prefix). Null when a team is malformed. */
export function memberTarget(kind: 'account' | 'team', value: string): string | null {
  const typed = value.trim();
  if (kind === 'account') return typed;
  const [org, team, ...rest] = typed.replace(/^team:/, '').split('/');
  return rest.length === 0 && ORG_NAME.test(org ?? '') && TEAM_NAME.test(team ?? '')
    ? teamEntry(org, team)
    : null;
}
