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

export class CheckContainer extends Container<Env> {
  defaultPort = 8080;
  enableInternet = false;
  sleepAfter = '2m';

  async run(job: CheckJob): Promise<Record<string, unknown>> {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    await this.startAndWaitForPorts({
      ports: [8080],
      startOptions: {
        entrypoint: ['/usr/local/bin/start-runtime', 'check-server'],
        envVars: { CHECK_TOKEN: secret },
      },
      cancellationOptions: { portReadyTimeoutMS: 90_000 },
    });
    try {
      const result = await this.containerFetch(
        new Request('http://check/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify(job),
        }),
      );
      const body = await result.json<Record<string, any>>();
      if (!result.ok)
        throw Object.assign(new Error(body.error?.message ?? 'Check executor failed'), {
          code: body.error?.code ?? 'CHECK_EXECUTOR',
        });
      return body;
    } finally {
      // One run per instance: never reuse a container that executed untrusted code.
      await this.stop();
    }
  }
}
