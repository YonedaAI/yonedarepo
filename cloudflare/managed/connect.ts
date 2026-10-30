// A repository's platform connection, made and unmade with the workspace owner's own session:
// the agents' scoped token and webhook when an agent is set up on it, and, once no agent of the
// workspace is set up there, the token revoked and the webhook swapped for a repo.deleted-only
// notice (so a later deletion still clears its reviews).
import { HOOK_EVENTS, type ManagedEnv, NOTICE_EVENTS, TOKEN_NAME, TOKEN_SCOPES } from './config';
import { type Json, Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';

/** Mints the agents' repository token and registers their webhook, as the owner. */
export async function connect(env: ManagedEnv, req: Request, repo: string, workspace: string) {
  const stub = repoStub(env, repo);
  const existing = await stub.connection();
  if (existing && !existing.revoked) return;
  const owner = new Platform(env, { forward: req });
  // Agents return to a repository that kept only its deletion notice: that hook is replaced.
  if (existing) await owner.deleteHook(repo, existing.hook_id).catch(alreadyGone);
  let name = TOKEN_NAME;
  let minted: Json;
  try {
    minted = await owner.createToken(repo, name, TOKEN_SCOPES);
  } catch (e) {
    // Token names are never reused: a revoked earlier token keeps the plain name.
    if (!(e instanceof PlatformError && e.code === 'ALREADY_EXISTS')) throw e;
    name = `${TOKEN_NAME}-${Date.now().toString(36)}`;
    minted = await owner.createToken(repo, name, TOKEN_SCOPES);
  }
  const hook = await owner.createHook(
    repo,
    `${env.PUBLIC_URL.replace(/\/$/, '')}/hooks/${repo}`,
    HOOK_EVENTS,
  );
  await stub.link(repo, {
    account: workspace,
    token_name: name,
    token: String(minted.token),
    hook_id: Number(hook.id),
    hook_secret: String(hook.secret),
  });
}

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
