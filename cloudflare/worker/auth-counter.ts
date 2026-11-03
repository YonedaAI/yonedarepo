// Every edge uses the same authority ID for a key. Cloudflare chooses its location.
import { bounded, durableJson } from './durable';
import { hmacHex } from './hmac';
import type { Env } from './types';

export function authCounterEnv(env: Env): Env {
  if (env.GLOBAL_AUTH_LIMITS !== 'on') return env;
  return {
    ...env,
    AUTH_LIMITER: {
      async limit({ key }: { key: string }) {
        if (!env.OWNER_TOKEN || !env.WORKSPACES) throw new Error('The auth service is unavailable');
        if (
          !key ||
          key.length > 256 ||
          [...key].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
        )
          return { success: false };
        const digest = await hmacHex(env.OWNER_TOKEN, `yoneda:global-auth-rate:v1\n${key}`);
        const namespace = env.WORKSPACES;
        const id = namespace.idFromName(`auth-rate:${digest}`);
        const result = await bounded(
          5000,
          durableJson<{ success?: unknown; error?: unknown }>(
            () => namespace.get(id),
            'https://workspace/command',
            JSON.stringify({
              op: 'auth_rate_limit',
              request: crypto.randomUUID().replaceAll('-', ''),
            }),
          ),
        );
        if (result.error) throw new Error('The auth service is unavailable');
        return { success: result.success === true };
      },
    },
  };
}
