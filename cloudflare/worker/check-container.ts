// The platform's check executor: the pinned runtime image started in `check-server`
// mode. It receives files and argv from the Worker and returns evidence; it holds no
// platform credentials and has no network, so a check cannot reach or alter the platform.
import { Container } from '@cloudflare/containers';
import type { Env } from './types';

export type CheckJob = {
  command: string[];
  timeout_seconds: number;
  files: { path: string; type: string; data_b64: string }[];
};

/** The container operations one check needs (the Durable Object, or a test double). */
export type CheckInstance = {
  startAndWaitForPorts(options: unknown): Promise<unknown>;
  containerFetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
};

/**
 * Runs one check and kills the instance whatever happens. One run per instance: a
 * container that executed untrusted code is never reused. The runtime is PID 1 without a
 * SIGTERM handler, so a polite stop is ignored and would hold a container slot until the
 * account limit refuses every later check; SIGKILL (destroy) always frees it.
 */
export async function runCheckOnce(
  instance: CheckInstance,
  job: CheckJob,
): Promise<Record<string, unknown>> {
  const secret = crypto.randomUUID() + crypto.randomUUID();
  try {
    // Every run starts a fresh instance: this is its cold start, reported with the result.
    const starting = Date.now();
    await instance.startAndWaitForPorts({
      ports: [8080],
      startOptions: {
        entrypoint: ['/usr/local/bin/start-runtime', 'check-server'],
        envVars: { CHECK_TOKEN: secret },
      },
      cancellationOptions: { portReadyTimeoutMS: 90_000 },
    });
    const startMs = Date.now() - starting;
    // The check server enforces the job's timeout; a stalled connection must not outlive it.
    const result = await instance.containerFetch(
      new Request('http://check/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout((job.timeout_seconds + 30) * 1000),
      }),
    );
    const body = await result.json<Record<string, any>>();
    if (!result.ok)
      throw Object.assign(new Error(body.error?.message ?? 'Check executor failed'), {
        code: body.error?.code ?? 'CHECK_EXECUTOR',
      });
    return { ...body, start_ms: startMs };
  } finally {
    await instance.destroy();
  }
}

export class CheckContainer extends Container<Env> {
  defaultPort = 8080;
  enableInternet = false;
  sleepAfter = '2m';

  run(job: CheckJob): Promise<Record<string, unknown>> {
    return runCheckOnce(this, job);
  }

  /** An instance left idle (its caller vanished mid-run) is killed, not asked to stop. */
  override async onActivityExpired() {
    if (this.ctx.container?.running) await this.destroy();
  }
}
