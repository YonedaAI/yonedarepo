// The platform's check executor: the pinned runtime image started in `check-server`
// mode. It receives files and argv from the Worker and returns evidence; it holds no
// platform credentials and has no network, so a check cannot reach or alter the platform.
import { Container } from '@cloudflare/containers';
import { jsonBody, STREAM_TYPE, streamBody } from './platform-check-stream';
import {
  type CheckReport,
  completeContainerCheck,
  executorDeadlineMs,
  failCheckRun,
  withDeadline,
} from './repo-checks';
import type { Env } from './types';

export type CheckJob = {
  command: string[];
  timeout_seconds: number;
  /** The files at the checked tree (within the runner's scope), content as raw bytes. */
  files: { path: string; type: string; data: Uint8Array }[];
};

/** The container operations one check needs (the Durable Object, or a test double). */
export type CheckInstance = {
  startAndWaitForPorts(options: unknown): Promise<unknown>;
  containerFetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
};

/** A started check's credentials and how long its container took to come up. */
export type Started = { secret: string; startMs: number };

/**
 * One run per instance: a container that executed untrusted code is never reused. The
 * runtime is PID 1 without a SIGTERM handler, so a polite stop is ignored and would hold a
 * container slot until the account limit refuses every later check; SIGKILL (destroy)
 * always frees it. So every path below ends in a kill.
 */

/** Starts a fresh instance for one check; one that cannot start is killed. */
export async function startCheck(instance: CheckInstance): Promise<Started> {
  const secret = crypto.randomUUID() + crypto.randomUUID();
  // Every run starts a fresh instance: this is its cold start, reported with the result.
  const starting = Date.now();
  try {
    await instance.startAndWaitForPorts({
      ports: [8080],
      startOptions: {
        entrypoint: ['/usr/local/bin/start-runtime', 'check-server'],
        envVars: { CHECK_TOKEN: secret },
      },
      cancellationOptions: { portReadyTimeoutMS: 90_000 },
    });
  } catch (e) {
    // The start failure is the answer (the consumer tells capacity from other causes);
    // a kill of an instance that never ran may fail too and must not replace it.
    await instance.destroy().catch(() => {});
    throw e;
  }
  return { secret, startMs: Date.now() - starting };
}

/** Executes a started check and kills the instance whatever happens. */
export async function executeCheck(instance: CheckInstance, job: CheckJob, started: Started) {
  try {
    // The check server enforces the job's timeout; a stalled connection must not outlive it.
    const post = (path: string, type: string, body: BodyInit) =>
      instance.containerFetch(
        new Request(`http://check${path}`, {
          method: 'POST',
          headers: { 'content-type': type, authorization: `Bearer ${started.secret}` },
          body,
          signal: AbortSignal.timeout((job.timeout_seconds + 30) * 1000),
        }),
      );
    let result = await post('/check/stream', STREAM_TYPE, streamBody(job));
    // A runtime image from before the stream route (mid-rollout) takes the JSON form.
    if (result.status === 404) result = await post('/check', 'application/json', jsonBody(job));
    const body = await result.json<Record<string, any>>();
    if (!result.ok)
      throw Object.assign(new Error(body.error?.message ?? 'Check executor failed'), {
        code: body.error?.code ?? 'CHECK_EXECUTOR',
      });
    return { ...body, start_ms: started.startMs };
  } finally {
    await instance.destroy();
  }
}

/**
 * Starts a claimed run's check and returns once its container is up: the check runs on in
 * the background (`keep`: the object's waitUntil) and completes the run itself, so the
 * queue consumer that claimed it is free for the next run at once. A consumer held for the
 * whole check made a burst of runs wait out each other's runtime with container slots
 * idle: max_concurrency is only a ceiling, and Queues adds consumers only between batches.
 * A container that cannot start throws here, before anything ran.
 */
export async function launchCheck(
  instance: CheckInstance,
  env: Env,
  job: CheckJob,
  report: CheckReport,
  keep: (work: Promise<unknown>) => void,
) {
  const started = await startCheck(instance);
  // The epoch ends itself well before its lease (timeout + 5 min) would: a stalled
  // container otherwise holds the run "running" until the lease lapses.
  const finished = withDeadline(
    executeCheck(instance, job, started),
    executorDeadlineMs(job.timeout_seconds),
    () => instance.destroy().catch(() => {}),
  );
  keep(
    finished.then(
      (result) => completeContainerCheck(env, report, result),
      (e) => failCheckRun(env, report, e),
    ),
  );
}

export class CheckContainer extends Container<Env> {
  defaultPort = 8080;
  enableInternet = false;
  sleepAfter = '2m';

  launch(job: CheckJob, report: CheckReport): Promise<void> {
    return launchCheck(this, this.env, job, report, (work) => this.ctx.waitUntil(work));
  }

  /** An instance left idle (its caller vanished mid-run) is killed, not asked to stop. */
  override async onActivityExpired() {
    if (this.ctx.container?.running) await this.destroy();
  }
}
