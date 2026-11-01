// A repository's platform connection, made and unmade with the workspace owner's own session:
// the agents' scoped token and webhook when an agent is set up on it, and, once no agent of the
// workspace is set up there, the token revoked and the webhook swapped for a repo.deleted-only
// notice (so a later deletion still clears its reviews).
import { HOOK_EVENTS, type ManagedEnv, NOTICE_EVENTS, TOKEN_NAME, TOKEN_SCOPES } from './config';
import { type Json, Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';

/** A new agents' token: the plain name, or a fresh one (token names are never reused, so a
 * revoked earlier token keeps the plain name). */
async function mint(owner: Platform, repo: string) {
  try {
    const minted = await owner.createToken(repo, TOKEN_NAME, TOKEN_SCOPES);
    return { name: TOKEN_NAME, token: String(minted.token) };
  } catch (e) {
    if (!(e instanceof PlatformError && e.code === 'ALREADY_EXISTS')) throw e;
    const name = `${TOKEN_NAME}-${Date.now().toString(36)}`;
    return { name, token: String((await owner.createToken(repo, name, TOKEN_SCOPES)).token) };
  }
}

/** Whether token `name` lacks a scope the agents now need, or was revoked (a deletion revokes
 * every token and a restore leaves them so). Unknown stays as it is: this only heals, and a
 * failed read must not stop an owner saving. */
async function outdated(owner: Platform, repo: string, name: string) {
  const listed = await owner.tokens(repo).catch(() => null);
  const row = (listed?.tokens as Json[] | undefined)?.find((t) => t.name === name);
  if (typeof row?.scopes !== 'string') return false;
  if (row.revoked_at) return true;
  const held: string[] = JSON.parse(row.scopes);
  return TOKEN_SCOPES.some((scope) => !held.includes(scope));
}

/** Mints the agents' repository token and registers their webhook, as the owner. A connection
 * whose token predates a scope the agents need, or did not survive a deletion that was undone,
 * gets a new token: only an owner can mint one, so this happens when an owner saves the agent.
 * A run still using the old token fails and says to reconnect. */
export async function connect(env: ManagedEnv, req: Request, repo: string, workspace: string) {
  const stub = repoStub(env, repo);
  const existing = await stub.connection();
  const owner = new Platform(env, { forward: req });
  if (existing && !existing.revoked) {
    if (!(await outdated(owner, repo, existing.token_name))) return;
    await stub.link(repo, { ...existing, ...tokenFields(await mint(owner, repo)) });
    await owner.revokeToken(repo, existing.token_name).catch(alreadyGone);
    return;
  }
  // Agents return to a repository that kept only its deletion notice: that hook is replaced.
  if (existing) await owner.deleteHook(repo, existing.hook_id).catch(alreadyGone);
  const minted = await mint(owner, repo);
  const hook = await owner.createHook(
    repo,
    `${env.PUBLIC_URL.replace(/\/$/, '')}/hooks/${repo}`,
    HOOK_EVENTS,
  );
  await stub.link(repo, {
    account: workspace,
    ...tokenFields(minted),
    hook_id: Number(hook.id),
    hook_secret: String(hook.secret),
  });
}

const tokenFields = ({ name, token }: { name: string; token: string }) => ({
  token_name: name,
  token,
});

const alreadyGone = (e: unknown) => {
  if (!(e instanceof PlatformError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
};

/**
 * Once no agent runs on a repository: its agent token is revoked and the agents webhook (change,
 * branch, repo) is replaced by one for repo.deleted alone, so the repository's reviews (runs,
 * findings, transcripts) are still cleared when it is deleted. A token or hook already gone is
 * fine.
 */
export async function disconnect(env: ManagedEnv, req: Request, repo: string) {
  const stub = repoStub(env, repo);
  const connection = await stub.connection().catch(() => null);
  if (!connection || connection.revoked) return;
  const owner = new Platform(env, { forward: req });
  await owner.revokeToken(repo, connection.token_name).catch(alreadyGone);
  await owner.deleteHook(repo, connection.hook_id).catch(alreadyGone);
  const notice = await owner.createHook(
    repo,
    `${env.PUBLIC_URL.replace(/\/$/, '')}/hooks/${repo}`,
    NOTICE_EVENTS,
  );
  await stub.retain(repo, { id: Number(notice.id), secret: String(notice.secret) });
}
