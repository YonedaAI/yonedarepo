// Proving someone owns the GitHub organization they installed the App on. An `installation_id`
// is anyone's to write, and the App can't see who belongs to an organization, so the person goes
// through the sign-in OAuth app once more with `read:org`, and GitHub answers for them.
//
// The token only lives inside `exchange`, for one call: nothing here sees it, and nothing keeps
// it. Only an active owner (`role: admin`) connects an organization, and only as the GitHub user
// this account linked, which stops one person proving an organization for another's account.

import { readTicket } from './github-org-ticket';
import { log } from './log';
import { type Client, exchange, type OrgRole, ProviderError } from './oauth-providers';
import { sha } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

export const ORG_SCOPE = 'read:user user:email read:org';

/** The account and ticket hash behind a `ticket` this account's store still holds. */
export async function orgTicket(env: Env, value: string | null) {
  const read = readTicket(value);
  if (!read) return null;
  const ticketHash = await sha(read.secret);
  const held = await workspace(env, read.account, {
    op: 'github_org_ticket_get',
    ticket_hash: ticketHash,
  }).catch(() => ({}) as Json);
  return held.installation ? { account: read.account, ticketHash } : null;
}

const REFUSED: Record<Exclude<OrgRole, 'owner'>, string> = {
  none: 'not_member',
  member: 'org_owner',
  blocked: 'org_blocked',
};

/** What the callback says to the app, in `?github=`. A refusal stores nothing. */
export async function provedOwner(
  env: Env,
  app: Client,
  redirect: string,
  flow: Json,
  code: string | null,
): Promise<string> {
  if (!code) return 'org_denied';
  try {
    const ticket = await workspace(env, flow.account, {
      op: 'github_org_ticket_take',
      ticket_hash: flow.session_hash,
    });
    if (!ticket.installation) return 'state';
    const { verifier, nonce } = flow;
    const person = await exchange('github', app, redirect, code, {
      verifier,
      nonce,
      org: ticket.login,
    });
    const { linked } = await workspace(env, flow.account, {
      op: 'identity_check',
      provider: 'github',
      subject: person.subject,
    });
    if (linked !== true) return 'other_account';
    if (person.orgRole !== 'owner') return REFUSED[person.orgRole ?? 'none'];
    await workspace(env, flow.account, {
      op: 'github_installation_put',
      installation: ticket.installation,
      login: ticket.login,
      target_type: 'Organization',
      target_id: ticket.target_id,
      connected_by: person.subject,
    });
    return 'connected';
  } catch (e) {
    if (!(e instanceof ProviderError)) log.error('oauth.github_org', { error: e });
    return 'unavailable';
  }
}
