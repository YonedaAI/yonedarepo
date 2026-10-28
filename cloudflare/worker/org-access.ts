// Organization access for one request: an account's role and teams in each org it joined,
// asked of each org's authority (the WorkspaceAuthority `account:<org>`), so a repository's
// authority can resolve org owners and team entries (`team:<org>/<team>`). The account's
// hints only say which orgs to ask; an org that does not list the account grants nothing.
// An isolate reuses an answer for at most ACCESS_MS from when its fetch started, and the
// isolate that served an org change drops its copies, so removing someone from a team or an
// org refuses them everywhere within ACCESS_MS of the change's answer: the same bound as a
// repository's own access changes (repo-head.ts).
import { ACCESS_MS } from './repo-head';
import type { Env, Json } from './types';
import { workspace } from './workspace';

export type OrgRole = 'owner' | 'member';
export type OrgAccess = Record<string, { role: OrgRole; teams: string[] }>;

/** Orgs asked per request at most (an account's hints beyond it are not resolved). */
const ORGS_PER_ACCOUNT = 100;
const CACHE_LIMIT = 10_000;
const answers = new Map<string, { at: number; value: Promise<Json | null> }>();
const key = (org: string, account: string) => `${org}\n${account}`;

/** The account's role and teams in `org`, or null when it is not a member. */
function ask(env: Env, org: string, account: string): Promise<Json | null> {
  const k = key(org, account);
  const cached = answers.get(k);
  if (cached && Date.now() - cached.at < ACCESS_MS) return cached.value;
  if (answers.size >= CACHE_LIMIT) {
    const now = Date.now();
    for (const [old, entry] of answers) if (now - entry.at >= ACCESS_MS) answers.delete(old);
  }
  const at = Date.now();
  const value = workspace(env, org, { op: 'org_access', account }).then(
    (answer) => (answer.role ? answer : null),
    (e) => {
      answers.delete(k);
      // A hint naming no org (or a person) grants nothing; anything else fails the request.
      if (e?.code === 'NOT_FOUND') return null;
      throw e;
    },
  );
  answers.set(k, { at, value });
  return value;
}

/** What `account` holds in the orgs it hints at, or undefined when none. */
export async function orgAccess(
  env: Env,
  account: string,
  hints: readonly string[],
): Promise<OrgAccess | undefined> {
  if (hints.length === 0) return undefined;
  const orgs = hints.slice(0, ORGS_PER_ACCOUNT);
  const answered = await Promise.all(orgs.map((org) => ask(env, org, account)));
  const access: OrgAccess = {};
  orgs.forEach((org, i) => {
    const answer = answered[i];
    if (answer) access[org] = { role: answer.role, teams: answer.teams ?? [] };
  });
  return Object.keys(access).length ? access : undefined;
}

/** After an org change this isolate served: its copies for `org` (one account's, or all). */
export function forgetOrgAccess(org: string, account?: string) {
  if (account) {
    answers.delete(key(org, account));
    return;
  }
  for (const k of answers.keys()) if (k.startsWith(`${org}\n`)) answers.delete(k);
}

/** The repository member entries `orgs` resolves to for its account: its teams'. */
export function teamEntries(orgs: OrgAccess | undefined): string[] {
  return Object.entries(orgs ?? {}).flatMap(([org, a]) => a.teams.map((t) => `team:${org}/${t}`));
}
