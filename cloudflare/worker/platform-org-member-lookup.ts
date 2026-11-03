// Owner-scoped member lookup. Projections suggest public handles; the account and
// handle authorities verify every result. Email lookup accepts only an exact address.
import { normalizeAccountIdentifier, normalizeHandle } from '../../shared/account';
import { accountSummary } from './account-index';
import { accountFor } from './email-accounts';
import { ApiError } from './repo-ops';
import type { Env, Json } from './types';
import { workspace } from './workspace';

type Person = { account: string; handle: string | null };
type Candidate = { identifier: string; handle: string | null; member: boolean };

/** Check the live org authority before reading any candidate's account or claim. */
export async function ownerMembers(env: Env, org: string, actor: string): Promise<string[]> {
  const shown = await workspace(env, org, { op: 'org_show', actor }).catch((e) => {
    throw typeof e?.code === 'string' ? new ApiError(e.code, e.message) : e;
  });
  if (shown.role !== 'owner')
    throw new ApiError('FORBIDDEN', 'Only organization owners can manage members');
  return shown.members.map((member: Json) => String(member.account));
}

async function publicPerson(env: Env, handle: string): Promise<Person | null> {
  const name = normalizeHandle(handle);
  if (!name) return null;
  const held = await workspace(env, name, { op: 'handle_lookup' }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
  if (!held || held.kind === 'org') return null;
  const summary = await accountSummary(env, held.account);
  if (!summary || summary.username !== held.account || summary.handle !== name) return null;
  return { account: held.account, handle: name };
}

/** Called only after ownerMembers. An existing canonical account stays the target. */
export async function resolveOrgMember(env: Env, input: unknown): Promise<Person | null> {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const identifier = normalizeAccountIdentifier(raw.startsWith('@') ? raw.slice(1) : raw);
  if (!identifier) return null;
  if (!identifier.includes('@')) return publicPerson(env, identifier);
  const account = await accountFor(env, identifier);
  const summary = await accountSummary(env, account);
  if (!summary || summary.username !== account) return null;
  if (account !== identifier && summary.email !== identifier) {
    const { identities } = await workspace(env, account, { op: 'identity_list' });
    if (!identities.some((identity: Json) => identity.email === identifier)) return null;
  }
  const publicHandle = summary.handle && (await publicPerson(env, summary.handle));
  return { account, handle: publicHandle?.account === account ? publicHandle.handle : null };
}

export async function memberCandidates(
  env: Env,
  org: string,
  actor: string,
  query: string,
): Promise<{ candidates: Candidate[] }> {
  const members = new Set(await ownerMembers(env, org, actor));
  const raw = query.trim();
  if (raw.length > 254) throw new ApiError('INVALID_INPUT', 'Search is too long');
  const text = raw.startsWith('@') ? raw.slice(1) : raw;
  if (text.includes('@')) {
    const email = normalizeAccountIdentifier(text);
    if (!email) return { candidates: [] };
    const person = await resolveOrgMember(env, email);
    return {
      candidates: person
        ? [{ identifier: raw, handle: person.handle, member: members.has(person.account) }]
        : [],
    };
  }
  const prefix = normalizeHandle(text);
  if (!prefix) return { candidates: [] };
  // Range comparisons treat underscores literally, unlike LIKE. No email column is read.
  const { results } = await env.INDEX.prepare(
    `SELECT handle FROM platform_handles WHERE handle>=?1 AND handle<?2
     UNION SELECT handle FROM platform_accounts WHERE handle>=?1 AND handle<?2
     UNION SELECT account AS handle FROM platform_accounts
       WHERE account>=?1 AND account<?2 AND instr(account,'@')=0
     ORDER BY handle LIMIT 10`,
  )
    .bind(prefix, `${prefix}\uffff`)
    .all<{ handle: string }>();
  // Exact known handles also work before their listing projection catches up.
  const handles = [...new Set([prefix, ...results.map((row) => row.handle)])];
  const people = await Promise.all(handles.map((handle) => publicPerson(env, handle)));
  return {
    candidates: people
      .filter((person): person is Person & { handle: string } => Boolean(person?.handle))
      .slice(0, 10)
      .map((person) => ({
        identifier: person.handle,
        handle: person.handle,
        member: members.has(person.account),
      })),
  };
}
