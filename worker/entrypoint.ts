import { WorkerEntrypoint } from 'cloudflare:workers';
import { authorized } from './auth';
import { evidence } from './evidence';
import { error, now, response, safeId } from './http';
import { ownerSession } from './session';
import { ledger, sha } from './storage';
import type { Env, Envelope, Json, Scope } from './types';
export class YonedaEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health')
      return response({
        service: 'yonedarepo',
        v: 1,
        models: { codex: this.env.CODEX_MODEL, claude: this.env.CLAUDE_MODEL },
      });
    if (!url.pathname.startsWith('/api/')) return this.env.ASSETS.fetch(req);
    if (!(await authorized(req, this.env)))
      return error('UNAUTHORIZED', 'Owner authentication is required', 401);
    try {
      if (url.pathname === '/api/session' && ['POST', 'DELETE'].includes(req.method))
        return ownerSession(req, this.env);
      if (url.pathname === '/api/repositories' && req.method === 'GET') {
        const result = await this.env.INDEX.prepare(
          'SELECT id,payload,seq FROM repositories ORDER BY id LIMIT 100',
        ).all();
        return response({
          repositories: result.results.map((r: any) => ({ ...JSON.parse(r.payload), seq: r.seq })),
        });
      }
      if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
        const { name } = await req.json<Json>();
        if (!safeId(name)) return error('INVALID_INPUT', 'Invalid repository name');
        try {
          const created = await this.env.ARTIFACTS.create(name, {
            setDefaultBranch: 'main',
            description: 'YonedaRepo demo',
          });
          using createdRepo = await this.env.ARTIFACTS.get(name);
          await createdRepo.revokeToken(created.token);
        } catch (e: any) {
          if (e.code !== 'ALREADY_EXISTS') throw e;
        }
        using repo = await this.env.ARTIFACTS.get(name);
        const existing = await repo.log({ ref: 'main', limit: 1 });
        if (existing.length)
          return response({ commit: existing[0].hash, remote: (await repo.info()).remote });
        const token = await repo.createToken('write', 300);
        return response({
          remote: (await repo.info()).remote,
          token: token.plaintext,
          token_id: token.id,
          expires: token.expiresAt,
        });
      }
      const parts = url.pathname.split('/').filter(Boolean);
      const repo = parts[2];
      const action = parts[3] ?? 'snapshot';
      if (parts[1] !== 'repos' || !safeId(repo))
        return error('NOT_FOUND', 'Unknown API route', 404);
      if (action === 'evidence' && req.method === 'GET')
        return evidence(this.env, repo, url.searchParams.get('digest') ?? '');
      if (action === 'live' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        await ledger(this.env, repo, { op: 'snapshot' });
        return this.env.LIVE.get(this.env.LIVE.idFromName(repo)).fetch(req);
      }
      const allowed =
        req.method === 'GET'
          ? ['snapshot', 'events', 'graph', 'why', 'decision']
          : req.method === 'POST'
            ? ['init', 'start_run', 'accept', 'cancel_run', 'observe', 'update_policy']
            : [];
      if (!allowed.includes(action)) return error('NOT_FOUND', 'Unknown repository operation', 404);
      const input: Json =
        req.method === 'GET' ? Object.fromEntries(url.searchParams) : await req.json<Json>();
      for (const key of ['after', 'depth'])
        if (input[key] !== undefined) input[key] = Number(input[key]);
      if (action === 'init') {
        if (input.id !== repo || input.remote?.namespace !== this.env.ARTIFACTS_NAMESPACE)
          return error('INVALID_INPUT', 'Repository identity mismatch');
        using remote = await this.env.ARTIFACTS.get(input.remote.name);
        const head = (await remote.log({ ref: 'main', limit: 1 }))[0]?.hash;
        if (head !== input.commit)
          return error('HEAD_MOVED', 'Initialization must use the actual canonical HEAD', 409);
      }
      const value = await ledger(this.env, repo, { ...input, op: action });
      if (action === 'cancel_run')
        for (const stop of value.stop) {
          const name = await sha(`${repo}:${stop.job_id}:${stop.epoch}`);
          await this.env.EXECUTIONS.get(this.env.EXECUTIONS.idFromName(name)).stop();
        }
      return response(value);
    } catch (e: any) {
      return error(e.code ?? 'REQUEST_FAILED', e.message ?? 'Request failed', 409);
    }
  }

  // Internal service RPC; these methods are not exposed through public fetch routes.
  async deliver(repo: string, entries: Json[]) {
    const delivered: string[] = [];
    for (const entry of entries) {
      try {
        if (entry.kind === 'live') {
          const res = await this.env.LIVE.get(this.env.LIVE.idFromName(repo)).fetch(
            'http://live/notify',
            { method: 'POST', body: JSON.stringify(entry.payload.event) },
          );
          if (!res.ok) throw new Error('Live notification failed');
        } else if (entry.kind === 'index') {
          await this.env.INDEX.prepare(
            'INSERT INTO repositories(id,payload,seq) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,seq=excluded.seq WHERE excluded.seq>repositories.seq',
          )
            .bind(repo, JSON.stringify(entry.payload.repository), entry.payload.seq)
            .run();
        } else {
          const queues: Record<string, Queue<Envelope>> = {
            agent: this.env.AGENT_QUEUE,
            capture: this.env.CAPTURE_QUEUE,
            evaluate: this.env.EVALUATE_QUEUE,
            publish: this.env.PUBLISH_QUEUE,
          };
          if (!queues[entry.kind]) throw new Error('Unknown outbox kind');
          await queues[entry.kind].send({
            v: 1,
            repo_id: repo,
            job_id: entry.payload.job_id,
            kind: entry.kind,
          });
        }
        delivered.push(entry.id);
      } catch {
        break;
      } // Durable outbox retries in order on the Repo DO alarm.
    }
    return delivered;
  }

  async queue(batch: MessageBatch<Envelope>) {
    await Promise.all(
      batch.messages.map(async (message) => {
        const envelope = message.body;
        try {
          if (envelope.v !== 1) {
            message.ack();
            return;
          }
          const job = await ledger(this.env, envelope.repo_id, {
            op: 'claim',
            job_id: envelope.job_id,
            models: { codex: this.env.CODEX_MODEL, claude: this.env.CLAUDE_MODEL },
          });
          if (job.already_done) {
            message.ack();
            return;
          }
          job.model =
            job.payload.execution?.harness === 'codex'
              ? this.env.CODEX_MODEL
              : this.env.CLAUDE_MODEL;
          const scope: Scope = {
            repo_id: envelope.repo_id,
            job,
            supervisor: crypto.randomUUID() + crypto.randomUUID(),
            model_calls: 0,
            created_at: now(),
          };
          if (job.kind === 'capture') {
            const canonical = job.payload.base.repository.split('/')[1];
            const name = `candidate-${(await sha(`${envelope.repo_id}:${job.id}:${job.epoch}`)).slice(0, 32)}`;
            using repo = await this.env.ARTIFACTS.get(canonical);
            try {
              const fork = await repo.fork(name, { defaultBranchOnly: true });
              using target = await this.env.ARTIFACTS.get(name);
              await target.revokeToken(fork.token);
            } catch (e: any) {
              if (e.code !== 'ALREADY_EXISTS') throw e;
            }
            job.fork = `${this.env.ARTIFACTS_NAMESPACE}/${name}`;
            scope.fork = job.fork;
          }
          const name = await sha(`${envelope.repo_id}:${job.id}:${job.epoch}`);
          await this.env.EXECUTIONS.get(this.env.EXECUTIONS.idFromName(name)).launch(scope);
          message.ack();
        } catch (e: any) {
          if (['LEASE_HELD', 'FENCED', 'ATTEMPTS_EXHAUSTED'].includes(e.code)) message.ack();
          else message.retry({ delaySeconds: 20 });
        }
      }),
    );
  }
}
