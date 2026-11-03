// Organization access for one request: an account's role and teams in each org it joined,
// asked of each org's authority (the WorkspaceAuthority `account:<org>`), so a repository's
// authority can resolve org owners and team entries (`team:<org>/<team>`). The account's
// hints only say which orgs to ask; an org that does not list the account grants nothing.
// An isolate reuses an answer for at most ACCESS_MS from when its fetch started, and the
// isolate that served an org change drops its copies, so removing someone from a team or an
// org refuses them everywhere within ACCESS_MS of the change's answer: the same bound as a
// repository's own access changes (repo-head.ts). Joining a team or an org is bounded the
// same way: another isolate may list and decide without it for under ACCESS_MS (unlike a
// repository grant, which a refused read asks the head holder about again at once).
import { noteOrg } from './account-place';
import { ACCESS_MS } from './repo-head';
import type { Env, Json } from './types';
import { workspace } from './workspace';

export type OrgRole = 'owner' | 'member';
/** A team as its org numbers it: ids are never reused, so a grant made to a deleted team
 * never reaches a later team of the same name. */
export type OrgTeam = { name: string; id: number };
export type OrgAccess = Record<string, { role: OrgRole; teams: OrgTeam[] }>;

/** Orgs asked per request at most (an account's hints beyond it are not resolved). */
const ORGS_PER_ACCOUNT = 100;
const CACHE_LIMIT = 10_000;
// Only completed JSON may cross request contexts; unfinished I/O stays with its caller.
const answers = new Map<string, { at: number; sequence: number; value: Json | null }>();
let generation = 0;
let sequence = 0;
const key = (org: string, account: string) => `${org}\n${account}`;

/** The account's role and teams in `org`, or null when it is not a member. */
async function ask(env: Env, org: string, account: string): Promise<Json | null> {
  const k = key(org, account);
  const cached = answers.get(k);
  if (cached && Date.now() - cached.at < ACCESS_MS) return cached.value;
  if (answers.size >= CACHE_LIMIT) {
    const now = Date.now();
    for (const [old, entry] of answers) if (now - entry.at >= ACCESS_MS) answers.delete(old);
  }
  const at = Date.now();
  const version = generation;
  const order = ++sequence;
  let value: Json | null;
  try {
    const answer = await workspace(env, org, { op: 'org_access', account });
    value = answer.role ? answer : null;
  } catch (e: any) {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  }
  // A slower old request cannot overwrite a newer answer or undo invalidation.
  if (
    generation === version &&
    Date.now() - at < ACCESS_MS &&
    (!answers.has(k) || (answers.get(k)?.sequence ?? 0) < order) &&
    (answers.has(k) || answers.size < CACHE_LIMIT)
  ) {
    answers.set(k, { at, sequence: order, value });
  }
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
    if (!answer) return;
    access[org] = { role: answer.role, teams: answer.teams ?? [] };
    noteOrg(env, answer);
  });
  return Object.keys(access).length ? access : undefined;
}

/** After an org change this isolate served: its copies for `org` (one account's, or all). */
export function forgetOrgAccess(org: string, account?: string) {
  generation++;
  if (account) {
    answers.delete(key(org, account));
    return;
  }
  for (const k of answers.keys()) if (k.startsWith(`${org}\n`)) answers.delete(k);
}

/** A team's repository member entry (`team:<org>/<team>#<id>`, as `members.rs` keys it). */
export const teamKey = (org: string, team: OrgTeam) => `team:${org}/${team.name}#${team.id}`;

/** The repository member entries `orgs` resolves to for its account: its teams'. */
export function teamEntries(orgs: OrgAccess | undefined): string[] {
  return Object.entries(orgs ?? {}).flatMap(([org, a]) => a.teams.map((t) => teamKey(org, t)));
}
