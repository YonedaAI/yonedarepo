// From platform webhooks to runs. The webhook receiver checks the platform's signature and
// queues the event; the queue consumer (at least once) finds the open change the event is
// about, claims one run per enabled agent for its head (idempotent), and starts that run's
// Workflow instance (also idempotent: the instance id is the run and attempt).
import { type ManagedAgentId, managedAgent, readyForReview } from '../../shared/managed-agents';
import { resolveSettings, triggerMatches } from '../../shared/managed-settings';
import { runTopUp } from './billing';
import { COMMIT_ID, type ManagedEnv, type QueueMessage, type RunParams } from './config';
import { Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';
import { instanceId } from './workflow';
import { workspaceStub } from './workspace-agents';

const json = (value: unknown, status = 200) => Response.json(value, { status });

/** `POST /hooks/<repo>`: a signed platform event. The platform names an event by family and
 * action (`change.opened`, `branch` with `action`, `repo.deleted`). */
export async function receiveHook(req: Request, env: ManagedEnv, repo: string): Promise<Response> {
  const body = await req.text();
  if (body.length > 256 * 1024) return json({ error: { code: 'TOO_LARGE' } }, 413);
  const signature = req.headers.get('x-yoneda-signature') ?? '';
  const stub = repoStub(env, repo);
  if (!(await stub.verify(body, signature))) {
    // A repository with nothing left here (already cleared, or never connected) has nothing to
    // delete: a repeated repo.deleted is acknowledged so the platform stops resending it.
    if (!(await stub.hasConnection()) && req.headers.get('x-yoneda-event') === 'repo.deleted')
      return json({ ignored: true }, 202);
    return json({ error: { code: 'UNAUTHORIZED' } }, 401);
  }
  let event: Record<string, any>;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: { code: 'INVALID_INPUT' } }, 400);
  }
  if (event.repo !== repo) return json({ error: { code: 'INVALID_INPUT' } }, 400);
  const name = String(event.event ?? '');
  if (name === 'repo.deleted') {
    await env.RUNS.send({ kind: 'deleted', repo });
    return json({ queued: true }, 202);
  }
  const family = name.split('.')[0];
  const action = name.includes('.') ? name.split('.')[1] : String(event.action ?? '');
  const commit = COMMIT_ID.test(String(event.commit)) ? String(event.commit) : null;
  const wanted =
    (family === 'change' && action === 'opened') ||
    (family === 'branch' && (action === 'moved' || action === 'created'));
  if (!wanted || !commit) return json({ ignored: true }, 202);
  const number = Number(event.change?.number);
  await env.RUNS.send({
    kind: 'event',
    repo,
    event: family,
    ref: typeof event.ref === 'string' ? event.ref : null,
    commit,
    change: Number.isSafeInteger(number) && number > 0 ? number : null,
    action,
  });
  return json({ queued: true }, 202);
}

const TRANSCRIPT_PAGE = 1000;

/** Deletes every transcript under `transcripts/<repo>/`, a page (at most 1,000 keys) at a time;
 * listing again from the start until none is left, so a retry resumes where it stopped. */
export async function purgeTranscripts(env: ManagedEnv, repo: string) {
  if (!env.TRANSCRIPTS) return 0;
  let deleted = 0;
  for (;;) {
    const page = await env.TRANSCRIPTS.list({
      prefix: `transcripts/${repo}/`,
      limit: TRANSCRIPT_PAGE,
    });
    if (page.objects.length > 0) {
      await env.TRANSCRIPTS.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
    }
    if (!page.truncated || page.objects.length === 0) return deleted;
  }
}

/**
 * repo.deleted: once the platform confirms the repository is GONE (it answers so before it
 * checks a credential, so even a revoked token tells), its transcripts, its workspace entries
 * and its RepoAgents state go, in that order: the connection, which names the workspace, goes
 * last, so a retry after a failure finds what is left. Billing entries stay.
 */
async function onDeleted(env: ManagedEnv, m: Extract<QueueMessage, { kind: 'deleted' }>) {
  const stub = repoStub(env, m.repo);
  const connection = await stub.connection().catch(() => null);
  if (!connection) return;
  const gone = await new Platform(env, { token: connection.token }).status(m.repo).then(
    () => false,
    (e) => {
      if (e instanceof PlatformError && e.code === 'GONE') return true;
      // A live repository refuses a revoked token; anything else may be passing.
      if (e instanceof PlatformError && e.status >= 400 && e.status < 500) return false;
      throw e;
    },
  );
  if (!gone) {
    console.warn(JSON.stringify({ event: 'managed.delete_refused', repo: m.repo }));
    return;
  }
  const transcripts = await purgeTranscripts(env, m.repo);
  await workspaceStub(env, connection.account).forget(m.repo);
  await stub.purge();
  console.log(JSON.stringify({ event: 'managed.repo_purged', repo: m.repo, transcripts }));
}

/** Starts a run's Workflow instance; an instance that already exists is left alone. */
async function startInstance(env: ManagedEnv, params: RunParams) {
  try {
    await env.REVIEWS.create({ id: instanceId(params.run, params.attempt), params });
  } catch (e: any) {
    if (!/already exists|already_exists|duplicate/i.test(String(e?.message ?? e))) throw e;
  }
}

async function onEvent(env: ManagedEnv, m: Extract<QueueMessage, { kind: 'event' }>) {
  const repo = repoStub(env, m.repo);
  const [connection, enabled] = await Promise.all([repo.connection(), repo.enabled()]);
  if (!connection || connection.revoked || enabled.length === 0 || !m.commit) return;
  const platform = new Platform(env, { token: connection.token });
  // The owner's break-glass pause stops automation, managed agents included.
  if (await platform.automationPaused(m.repo)) return;
  const open = ((await platform.openChanges(m.repo)).changes ?? []) as Record<string, any>[];
  const branch = m.ref?.startsWith('refs/heads/') ? m.ref.slice('refs/heads/'.length) : null;
  // Only the change's current head is reviewed; an event for an older head is stale.
  const changes = open.filter(
    (c) => c.head === m.commit && (m.change ? c.number === m.change : c.branch === branch),
  );
  await reviewChanges(
    env,
    m.repo,
    { account: connection.account, platform },
    enabled,
    changes,
    m.event === 'change',
  );
}

/**
 * Claims one run per agent for each change at its current head (idempotent: a head already
 * claimed is counted as `already`) and starts its Workflow instance, as each agent's trigger
 * allows: "when marked ready" only when the change opened (`opened`), "ready for review" never
 * for a change marked as a draft, and the path and branch filters.
 */
export async function reviewChanges(
  env: ManagedEnv,
  repoId: string,
  ctx: { account: string; platform: Platform },
  agents: ManagedAgentId[],
  changes: Record<string, any>[],
  opened: boolean,
) {
  const repo = repoStub(env, repoId);
  const workspace = workspaceStub(env, ctx.account);
  const counts = { started: 0, already: 0 };
  for (const change of changes) {
    let paths: string[] | null = null;
    for (const id of agents) {
      const agent = managedAgent(id);
      if (!agent) continue;
      const stored = await workspace.settings(id);
      const s = resolveSettings(agent, stored.workspace, stored.repos[repoId]);
      if (s.trigger.when === 'ready' && !opened) continue;
      if (s.trigger.changes === 'ready_for_review' && !readyForReview(change)) continue;
      if (s.trigger.paths.length && paths === null)
        paths = (
          ((await ctx.platform.change(repoId, change.number)).diff?.changes ?? []) as {
            path: string;
          }[]
        ).map((f) => String(f.path));
      if (!triggerMatches(s.trigger, String(change.branch), paths ?? [])) continue;
      const claim = await repo.claim(repoId, id, change.number, String(change.head), {
        harness: s.harness,
        provider: s.provider,
        model: s.model,
      });
      if (!claim) continue;
      if (!claim.created) counts.already++;
      // A head claimed before is started again only while it waits for its instance (a lost
      // start); the instance id makes that a no-op otherwise.
      if (!claim.created && !claim.queued) continue;
      await startInstance(env, {
        repo: repoId,
        account: ctx.account,
        agent: id,
        run: claim.run,
        attempt: claim.attempt,
        change: change.number,
        head: String(change.head),
      });
      if (claim.created) counts.started++;
    }
  }
  return counts;
}

async function onResume(env: ManagedEnv, m: Extract<QueueMessage, { kind: 'resume' }>) {
  const repo = repoStub(env, m.repo);
  const connection = await repo.connection();
  if (!connection || connection.revoked) return;
  const next = await repo.resume(m.run);
  if (!next) return;
  await startInstance(env, {
    repo: m.repo,
    account: connection.account,
    agent: next.agent,
    run: m.run,
    attempt: next.attempt,
    change: next.change,
    head: next.head,
  });
}

export async function consume(batch: MessageBatch<QueueMessage>, env: ManagedEnv) {
  for (const message of batch.messages) {
    try {
      const m = message.body;
      if (m.kind === 'event') await onEvent(env, m);
      else if (m.kind === 'resume') await onResume(env, m);
      else if (m.kind === 'deleted') await onDeleted(env, m);
      else if (m.kind === 'topup') await runTopUp(env, m);
      message.ack();
    } catch (e: any) {
      console.error(
        JSON.stringify({
          event: 'managed.queue',
          code: e?.code ?? 'ERROR',
          message: String(e?.message ?? e).slice(0, 200),
        }),
      );
      message.retry({ delaySeconds: 30 });
    }
  }
}
