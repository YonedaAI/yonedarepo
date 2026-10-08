import { WorkerEntrypoint } from 'cloudflare:workers';
import { now } from './http';
import { fetchRequest } from './routes';
import { modelForJob } from './runtime';
import { authorizePreview } from './sites';
import { ledger, sha } from './storage';
import type { Env, Envelope, Json, Scope } from './types';
export class YonedaEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    return fetchRequest(req, this.env);
  }

  async authorizePreview(digest: string, token: string) {
    return authorizePreview(this.env, digest, token);
  }
  async siteManifest(repo: string): Promise<{ digest: string; commit: string } | null> {
    const snapshot = await ledger(this.env, repo, { op: 'snapshot' });
    return snapshot.repository.site ?? null;
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
          job.model = modelForJob(job, {
            codex: this.env.CODEX_MODEL,
            claude: this.env.CLAUDE_MODEL,
          });
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
              try {
                using existing = await this.env.ARTIFACTS.get(name);
                await existing.info();
              } catch {
                throw e;
              }
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
