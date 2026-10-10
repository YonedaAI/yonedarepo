import { deliverDeletion } from './repository-deletion';
import { sha } from './storage';
import type { Env, Envelope, Json } from './types';

export async function deliverOutbox(env: Env, repo: string, entries: Json[]) {
  const delivered: string[] = [];
  for (const entry of entries) {
    try {
      if (entry.kind === 'live') {
        const res = await env.LIVE.get(env.LIVE.idFromName(repo)).fetch('http://live/notify', {
          method: 'POST',
          body: JSON.stringify(entry.payload.event),
        });
        if (!res.ok) throw new Error('Live notification failed');
      } else if (entry.kind === 'index') {
        await env.INDEX.prepare(
          'INSERT INTO repositories(id,payload,seq) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,seq=excluded.seq WHERE excluded.seq>repositories.seq',
        )
          .bind(repo, JSON.stringify(entry.payload.repository), entry.payload.seq)
          .run();
      } else if (['workspace_delete', 'delete_artifact'].includes(entry.kind)) {
        await deliverDeletion(env, repo, entry);
      } else if (entry.kind === 'stop') {
        const name = await sha(`${repo}:${entry.payload.job_id}:${entry.payload.epoch}`);
        await env.EXECUTIONS.get(env.EXECUTIONS.idFromName(name)).stop();
      } else {
        const queues: Record<string, Queue<Envelope>> = {
          agent: env.AGENT_QUEUE,
          capture: env.CAPTURE_QUEUE,
          evaluate: env.EVALUATE_QUEUE,
          publish: env.PUBLISH_QUEUE,
        };
        if (!queues[entry.kind]) throw new Error('Unknown outbox kind');
        await queues[entry.kind].send(
          {
            v: 1,
            repo_id: repo,
            job_id: entry.payload.job_id,
            kind: entry.kind,
          },
          {
            delaySeconds: Math.min(
              43200,
              Math.max(0, Math.ceil(((entry.payload.not_before ?? 0) - Date.now()) / 1000)),
            ),
          },
        );
      }
      delivered.push(entry.id);
    } catch {
      // Deleted repositories are already fenced. Independent cleanup must still progress
      // when one container, projection or remote is unavailable; only successes are acked.
      if (entry.repository_deleted === true) continue;
      break;
    } // Durable outbox retries in order on the Repo DO alarm.
  }
  return delivered;
}
