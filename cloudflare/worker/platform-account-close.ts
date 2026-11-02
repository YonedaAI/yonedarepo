// Deleting an account, by its owner or an operator. The steps run in order and each repeats
// safely, as what they read is what the last one left: a run that dies is run again, by the
// person signing in once more or by an operator, and the account stays until the very last step,
// which is what makes it findable. Nothing changes while anything refuses.
//
// Refused: a legal hold; an organization the account alone owns (it would be left with no owner,
// or, with no other member, it has repositories of its own to think about); a repository still
// importing; and a repository with forks of someone else's, which read its objects. Its own forks
// go first. accounts/closure.rs holds the authority's half.
//
// Its name is free for someone else from the last step on, so nothing may be left that the name
// alone would open: the account leaves every repository it was a member of, and its tombstones
// are moved to a name no session can hold (`closed:…`). They purge on the schedule as ever, and
// nobody can bring them back.

import { accountSummary } from './account-index';
import { cellFetcher, cellOfRegion, cellsOn, thisCell } from './cells';
import { log } from './log';
import { closurePart, type Refusal, type Row } from './platform-account-close-part';
import { managed, managedCredit } from './platform-admin-billing';
import { audit } from './platform-admin-queries';
import { githubAppOn, uninstall } from './platform-github-app';
import { connection } from './platform-github-connect';
import { holdSwitch } from './platform-legal-hold';
import { forgetOrgAccess } from './platform-org-access';
import { releaseClaims } from './platform-ssh-keys';
import { deleteRepository } from './repo-admin';
import { refreshHead } from './repo-head';
import { ApiError, type Credentials, caller, type Json } from './repo-ops';
import { undoMs } from './repo-undo-window';
import { sha } from './storage';
import type { Env } from './types';
import { workspace } from './workspace';

const gone = (e: any) => ['GONE', 'NOT_FOUND'].includes(e?.code);

/** The name no session can hold that a closed account's tombstones move to. */
const successorOf = async (account: string) => `closed:${(await sha(account)).slice(0, 16)}`;

async function orgRefusals(env: Env, account: string, orgs: string[]): Promise<Refusal[]> {
  const refused: Refusal[] = [];
  for (const org of orgs) {
    const shown = await workspace(env, org, { op: 'org_show', actor: account }).catch((e) => {
      if (gone(e) || e?.code === 'FORBIDDEN') return null; // a stale hint
      throw e;
    });
    const members = (shown?.members ?? []) as { account: string; role: string }[];
    const owners = members.filter((m) => m.role === 'owner');
    if (owners.length !== 1 || owners[0].account !== account) continue;
    refused.push({
      reason: 'org',
      message:
        members.length > 1
          ? `You're the only owner of ${org}. Make someone else an owner first.`
          : `You're the only member of ${org}. Delete it first.`,
    });
  }
  return refused;
}

/** What deleting `account` would take, or null when there is no such account. */
export async function closurePlan(env: Env, account: string, sessionHash?: string) {
  const facts = await workspace(env, account, {
    op: 'account_closure_plan',
    ...(sessionHash && { session_hash: sessionHash }),
  }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
  if (!facts) return null;
  const parts = await Promise.all([
    closurePart(env, account),
    ...(await cellsHolding(env, account)).map((cell) => cellOf(env, cell).closurePart(account)),
  ]);
  const [own] = parts;
  // A hold is the account's: each cell finds the same one.
  const once = new Map(parts.flatMap((part) => part.refusals).map((r) => [r.message, r]));
  const refusals = [...(await orgRefusals(env, account, facts.orgs as string[])), ...once.values()];
  return { facts, repos: own.repos, forks: own.forks, refusals, count: repoCount(parts) };
}

const repoCount = (parts: { repos: Row[] }[]) =>
  parts.reduce((total, part) => total + part.repos.length, 0);

/** The account's repositories in this cell gone, its tombstones moved and its memberships
 * left. Each step repeats safely, as the account's own do. */
export async function closeCell(env: Env, account: string) {
  const { repos, forks } = await closurePart(env, account);
  await deleteRepositories(env, account, repos, forks);
  await moveTombstones(env, account);
  await leaveRepositories(env, account);
}

/** The other cells with anything of `account`'s. */
async function cellsHolding(env: Env, account: string) {
  if (!cellsOn(env)) return [];
  const { region, cells } = await workspace(env, account, { op: 'account_place' });
  const held = new Set<string>([cellOfRegion(env, region), ...(cells as string[])]);
  held.delete(thisCell(env));
  return [...held];
}

type CellClosure = {
  closurePart(account: string): Promise<Awaited<ReturnType<typeof closurePart>>>;
  closeCell(account: string): Promise<void>;
  unlistCell(account: string): Promise<void>;
};
const cellOf = (env: Env, cell: string) => {
  const fetcher = cellFetcher(env, cell);
  if (!fetcher) throw new ApiError('CELL_UNAVAILABLE', `The ${cell} region is not reachable here`);
  return fetcher as unknown as CellClosure;
};

/** A personal session for `account`: the repository path's own rules then apply. */
const asOwner = (account: string): Credentials => ({
  _session: { workspace: account, principal: `user:${account}`, human: true },
});

/** Forks before what they read: a repository refuses to go while one is left. */
async function deleteRepositories(
  env: Env,
  account: string,
  repos: Row[],
  forks: Map<string, string[]>,
) {
  let left = repos;
  while (left.length > 0) {
    const ids = new Set(left.map((r) => r.id));
    const free = left.filter((r) => !(forks.get(r.id) ?? []).some((fork) => ids.has(fork)));
    if (free.length === 0) throw new ApiError('CONFLICT', 'Forks left a repository undeletable');
    for (const repo of free) await deleteRepository(env, asOwner(account), repo.id, repo.name);
    left = left.filter((r) => !free.includes(r));
  }
}

/** Its tombstones out of reach of whoever takes the name next, still on the purge schedule. */
async function moveTombstones(env: Env, account: string) {
  const successor = await successorOf(account);
  const { results } = await env.INDEX.prepare(
    `SELECT id,name,visibility,created_at,deleted_at,purge_at FROM platform_deleted_repos
       WHERE workspace=?`,
  )
    .bind(account)
    .all<Json>();
  for (const { id, ...entry } of results) {
    await caller(env, id, { _system: 'close' })({
      op: 'repo_account_closed',
      account,
      successor,
    }).catch((e) => {
      if (!gone(e)) throw e;
    });
    await workspace(env, successor, { op: 'deleted_repo_put', repo: id, entry });
    await env.INDEX.prepare('UPDATE platform_deleted_repos SET workspace=? WHERE id=?')
      .bind(successor, id)
      .run();
  }
}

async function leaveRepositories(env: Env, account: string) {
  const { results } = await env.INDEX.prepare('SELECT repo FROM platform_members WHERE account=?')
    .bind(account)
    .all<{ repo: string }>();
  for (const { repo } of results) {
    await caller(env, repo, { _system: 'close' })({ op: 'repo_account_closed', account }).catch(
      (e) => {
        if (!gone(e)) throw e;
      },
    );
    await env.INDEX.prepare('DELETE FROM platform_members WHERE repo=? AND account=?')
      .bind(repo, account)
      .run();
    await refreshHead(env, repo, true);
  }
}

async function leaveOrgs(env: Env, account: string, orgs: string[]) {
  for (const org of orgs) {
    await workspace(env, org, { op: 'org_member_remove', account, actor: account }).catch((e) => {
      // A run before this one left it already.
      if (!gone(e) && e?.code !== 'FORBIDDEN') throw e;
    });
    forgetOrgAccess(org, account);
  }
}

/** Takes the App off their GitHub account, if it is still theirs to take off. A failure leaves
 * an installation nothing here points to, which grants nothing. */
async function disconnectGitHub(env: Env, account: string) {
  if (!githubAppOn(env)) return;
  try {
    const held = await connection(env, account);
    if (held.state === 'ok') await uninstall(env, held.installation);
  } catch (e) {
    log.warn('account.uninstall_failed', { error: e });
  }
}

/** Frees the claim on `key`, on its own authority instance (oauth-identity.ts holds them).
 * Releasing only ever frees what this account holds, so a repeat can't touch a claim someone
 * has taken since. */
async function release(env: Env, key: string, account: string) {
  const answer = await env.WORKSPACES.get(env.WORKSPACES.idFromName(key)).fetch(
    'http://workspace/command',
    { method: 'POST', body: JSON.stringify({ op: 'identity_claim_release', account, key }) },
  );
  if (!answer.ok) throw new Error('A sign-in claim could not be released');
}

/** Its identities and addresses free for sign-up and linking. */
async function releaseSignIns(env: Env, account: string, facts: Json) {
  for (const { provider, subject } of facts.identities as Json[])
    await release(env, `identity:${provider}:${subject}`, account);
  const emails = new Set<string>(
    [facts.email, ...(facts.identities as Json[]).map((i) => i.email)].filter(Boolean),
  );
  if (account.includes('@')) emails.add(account);
  for (const email of emails) await release(env, `email:${await sha(email)}`, account);
  if (account.includes('@') && facts.handle)
    await workspace(env, String(facts.handle), { op: 'handle_release', account }).catch((e) => {
      if (!gone(e)) throw e;
    });
}

/** Out of the listings. `admin_audit` stays, as operators' actions must, under a name that is
 * no address and no handle. */
export async function unlist(env: Env, account: string) {
  const successor = await successorOf(account);
  await env.INDEX.batch([
    env.INDEX.prepare('DELETE FROM platform_tokens WHERE workspace=?').bind(account),
    env.INDEX.prepare('DELETE FROM platform_handles WHERE workspace=?').bind(account),
    env.INDEX.prepare('DELETE FROM platform_accounts WHERE account=?').bind(account),
    env.INDEX.prepare('UPDATE admin_audit SET target=? WHERE target=?').bind(successor, account),
  ]);
}

/** Deletes `account` (see the module comment). Answers what went. */
export async function closeAccount(env: Env, actor: string, account: string) {
  const plan = await closurePlan(env, account);
  if (!plan) return { closed: false };
  const [refused] = plan.refusals;
  if (refused) throw new ApiError('CONFLICT', refused.message, { refusals: plan.refusals });
  const { facts, count } = plan;
  const elsewhere = (await cellsHolding(env, account)).map((cell) => cellOf(env, cell));
  // Every cell's, before anything the account's own authority holds goes.
  await Promise.all(elsewhere.map((cell) => cell.closeCell(account)));
  await closeCell(env, account);
  await leaveOrgs(env, account, facts.orgs as string[]);
  await disconnectGitHub(env, account);
  await releaseClaims(env, account, facts.ssh_keys as { id: string; fingerprint: string }[]);
  await workspace(env, account, { op: 'account_credentials_end' });
  const closed =
    env.MANAGED && env.MANAGED_ADMIN_TOKEN
      ? await managed(env, 'POST', `/admin/accounts/${encodeURIComponent(account)}/close`)
      : null;
  await releaseSignIns(env, account, facts);
  await Promise.all(elsewhere.map((cell) => cell.unlistCell(account)));
  await unlist(env, account);
  await workspace(env, account, { op: 'account_close', ...holdSwitch(env) });
  await audit(env, actor, 'account.close', await successorOf(account), {
    repos: count,
    forfeited_usd: closed?.forfeited_usd ?? 0,
  });
  return { closed: true, repos: count, forfeited_usd: closed?.forfeited_usd ?? 0 };
}

/** What the dialog says will go. */
export async function closurePreview(env: Env, account: string, sessionHash?: string) {
  const plan = await closurePlan(env, account, sessionHash);
  if (!plan) throw new ApiError('NOT_FOUND', 'No such account');
  const credit = await managedCredit(env, 'GET', account).catch(() => null);
  const summary = await accountSummary(env, account).catch(() => null);
  return {
    account,
    handle: plan.facts.handle ?? null,
    repos: plan.count,
    credit_usd: Math.max(0, Number(credit?.balance?.balance ?? 0)) / 1_000_000,
    undo_days: Math.round(undoMs(env) / 86_400_000),
    providers: summary?.providers ?? [],
    refusals: plan.refusals,
    session_age_ms: plan.facts.session_age_ms ?? null,
  };
}
