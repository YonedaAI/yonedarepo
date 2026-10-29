// From platform webhooks to runs. The webhook receiver checks the platform's signature and
// queues the event; the queue consumer (at least once) finds the open change the event is
// about, claims one run per enabled agent for its head (idempotent), and starts that run's
// Workflow instance (also idempotent: the instance id is the run and attempt).
import {
  agentConfig,
  COMMIT_ID,
  type ManagedEnv,
  type QueueMessage,
  type RunParams,
} from './config';
import { Platform } from './platform';
import { repoStub } from './repo-agents';
import { instanceId } from './workflow';

const json = (value: unknown, status = 200) => Response.json(value, { status });

/** `POST /hooks/<repo>`: a signed platform event. */
export async function receiveHook(req: Request, env: ManagedEnv, repo: string): Promise<Response> {
  const body = await req.text();
  if (body.length > 256 * 1024) return json({ error: { code: 'TOO_LARGE' } }, 413);
  const signature = req.headers.get('x-yoneda-signature') ?? '';
  if (!(await repoStub(env, repo).verify(body, signature)))
    return json({ error: { code: 'UNAUTHORIZED' } }, 401);
  let event: Record<string, any>;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: { code: 'INVALID_INPUT' } }, 400);
  }
  if (event.repo !== repo) return json({ error: { code: 'INVALID_INPUT' } }, 400);
  const commit = COMMIT_ID.test(String(event.commit)) ? String(event.commit) : null;
  const wanted =
    (event.event === 'change' && event.action === 'opened') ||
    (event.event === 'branch' && (event.action === 'moved' || event.action === 'created'));
  if (!wanted || !commit) return json({ ignored: true }, 202);
  const number = Number(event.change?.number);
  await env.RUNS.send({
    kind: 'event',
    repo,
    event: String(event.event),
    ref: typeof event.ref === 'string' ? event.ref : null,
    commit,
    change: Number.isSafeInteger(number) && number > 0 ? number : null,
    action: String(event.action),
  });
  return json({ queued: true }, 202);
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
  if (!connection || enabled.length === 0 || !m.commit) return;
  const platform = new Platform(env, { token: connection.token });
  const open = ((await platform.openChanges(m.repo)).changes ?? []) as Record<string, any>[];
  const branch = m.ref?.startsWith('refs/heads/') ? m.ref.slice('refs/heads/'.length) : null;
  // Only the change's current head is reviewed; an event for an older head is stale.
  const changes = open.filter(
    (c) => c.head === m.commit && (m.change ? c.number === m.change : c.branch === branch),
  );
  for (const change of changes) {
    for (const id of enabled) {
      let agent: ReturnType<typeof agentConfig>;
      try {
        agent = agentConfig(env, id);
      } catch (e: any) {
        console.error(JSON.stringify({ event: 'managed.config', agent: id, message: e?.message }));
        continue;
      }
      const claim = await repo.claim(
        m.repo,
        id,
        change.number,
        m.commit,
        agent.provider,
        agent.model,
      );
      if (!claim || (!claim.created && !claim.queued)) continue;
      await startInstance(env, {
        repo: m.repo,
        account: connection.account,
        agent: id,
        run: claim.run,
        attempt: claim.attempt,
        change: change.number,
        head: m.commit,
      });
    }
  }
}

async function onResume(env: ManagedEnv, m: Extract<QueueMessage, { kind: 'resume' }>) {
  const repo = repoStub(env, m.repo);
  const connection = await repo.connection();
  if (!connection) return;
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
