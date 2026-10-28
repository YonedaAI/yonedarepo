// Git over SSH on Cloudflare. One SshGateway container (`yoneda-ssh-gateway`,
// cloudflare/ssh-gateway/Dockerfile) authenticates keys and bridges Git's SSH transport onto
// this Worker's smart-HTTP endpoints. Its only route to the platform is
// http://platform.internal, which `outboundByHost` hands to this Worker (SELF) for the
// /internal/ssh and /git paths alone. SSH_FRONT_DOOR picks how clients reach it:
//
// - `tunnel` (works today): the container also runs cloudflared with SSH_TUNNEL_TOKEN, and the
//   tunnel routes SSH_HOST to the gateway's port. Clients use `cloudflared access ssh` as
//   their ProxyCommand; with no Access application on the hostname it connects without a
//   login, and the gateway's key check is the only authentication. The container needs the
//   internet for cloudflared, and is kept running: the platform's cron calls `keepAlive`
//   every minute and it never sleeps.
// - `connect` (private beta): Spectrum hands inbound TCP to this Worker's `connect()`
//   handler (sshFrontDoor), piped to the container's port. Public inbound TCP to Workers is
//   not generally available yet.
// - `off` (or unset): neither; no gateway container starts.
import { Container, type StopParams } from '@cloudflare/containers';
import { deferred } from './background';
import type { Env } from './types';

/** The gateway's SSH listener inside its container (unprivileged; clients use port 22). */
export const SSH_PORT = 2222;
/** Its HTTP health listener, which container start-up waits for. */
const HEALTH_PORT = 8080;
export const PLATFORM_HOST = 'platform.internal';
/** The one gateway instance (both front doors). */
export const GATEWAY = 'ssh-gateway-0';
const PLATFORM_PATHS =
  /^\/(internal\/ssh\/(lookup|session|status)|git\/r[0-9a-f]{20}(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack))$/;

export type FrontDoor = 'tunnel' | 'connect';
/** The configured front door, or null when SSH is off. */
export const frontDoor = (env: Env): FrontDoor | null =>
  env.SSH_FRONT_DOOR === 'tunnel' || env.SSH_FRONT_DOOR === 'connect' ? env.SSH_FRONT_DOOR : null;

/** The container's request to the platform, served by this Worker; nothing else is
 * reachable from it. */
export function forwardToPlatform(req: Request, env: Env): Promise<Response> | Response {
  const url = new URL(req.url);
  if (!env.SELF || !PLATFORM_PATHS.test(url.pathname))
    return new Response('Not reachable from the SSH gateway\n', { status: 403 });
  const target = new URL(`${url.pathname}${url.search}`, 'https://platform.internal');
  return env.SELF.fetch(new Request(target, req));
}

/** The container's start environment for a front door; throws when a secret is missing. */
export function gatewayStart(env: Env, door: FrontDoor) {
  const { SSH_GATEWAY_SECRET, SSH_HOST_ED25519_KEY, SSH_HOST_ECDSA_KEY, SSH_TUNNEL_TOKEN } = env;
  if (!SSH_GATEWAY_SECRET || !SSH_HOST_ED25519_KEY || !SSH_HOST_ECDSA_KEY)
    throw new Error('SSH gateway secrets are not configured');
  if (door === 'tunnel' && !SSH_TUNNEL_TOKEN) throw new Error('SSH_TUNNEL_TOKEN is not configured');
  const envVars: Record<string, string> = {
    PLATFORM_URL: `http://${PLATFORM_HOST}`,
    SSH_LISTEN: `0.0.0.0:${SSH_PORT}`,
    HEALTH_LISTEN: `0.0.0.0:${HEALTH_PORT}`,
    SSH_GATEWAY_SECRET,
    SSH_HOST_ED25519_KEY,
    SSH_HOST_ECDSA_KEY,
  };
  if (door === 'tunnel' && SSH_TUNNEL_TOKEN) {
    // cloudflared reads these itself; HTTP/2 over TCP rather than QUIC over UDP.
    envVars.TUNNEL_TOKEN = SSH_TUNNEL_TOKEN;
    envVars.TUNNEL_TRANSPORT_PROTOCOL = 'http2';
  }
  // Only cloudflared needs the internet; the platform is reached through this Worker.
  return { envVars, enableInternet: door === 'tunnel' };
}

/** Pipes two sockets into each other until either side ends, then closes both. */
async function splice(a: Socket, b: Socket) {
  await Promise.allSettled([a.readable.pipeTo(b.writable), b.readable.pipeTo(a.writable)]);
  await Promise.allSettled([a.close(), b.close()]);
}

export class SshGateway extends Container<Env> {
  defaultPort = HEALTH_PORT;
  sleepAfter = '30m';
  enableInternet = false;
  /** Open `connect()` connections: without the tunnel it sleeps only when there are none. */
  private open = 0;

  private async ready() {
    const door = frontDoor(this.env);
    if (!door) throw new Error('SSH is off (SSH_FRONT_DOOR)');
    await this.startAndWaitForPorts({
      ports: [HEALTH_PORT],
      startOptions: gatewayStart(this.env, door),
      cancellationOptions: { portReadyTimeoutMS: 60_000 },
    });
  }

  /** The tunnel front door's keep-alive (the platform's cron): starts the container if it
   * stopped (a deploy, a crash) and resets its sleep timer. */
  async keepAlive() {
    const started = !this.ctx.container?.running;
    await this.ready();
    this.renewActivityTimeout();
    return { started };
  }

  // Lifecycle in `wrangler tail` (the container's own output is in its logs, and the
  // gateway reports cloudflared's state through /internal/ssh/status).
  override onStart() {
    log('ssh.container_started', {});
  }
  override onStop(params: StopParams) {
    log('ssh.container_stopped', { exit_code: params.exitCode, reason: params.reason });
  }
  override onError(error: unknown) {
    log('ssh.container_error', { error: String(error).slice(0, 300) });
    throw error;
  }

  /** One SSH connection, forwarded from the `connect` front door. */
  async connect(socket: Socket) {
    this.open++;
    try {
      await this.ready();
      const ssh = this.ctx.container?.getTcpPort(SSH_PORT).connect(`10.0.0.1:${SSH_PORT}`);
      if (!ssh) throw new Error('SSH gateway container is not available');
      await ssh.opened;
      await splice(socket, ssh);
    } catch (e) {
      console.error(
        JSON.stringify({ event: 'ssh.gateway_failed', error: String(e).slice(0, 200) }),
      );
      await socket.close().catch(() => {});
    } finally {
      this.open--;
      this.renewActivityTimeout();
    }
  }

  /** Behind the tunnel the gateway never sleeps (cloudflared holds the front door). */
  override async onActivityExpired() {
    if (this.open > 0 || frontDoor(this.env) === 'tunnel') this.renewActivityTimeout();
    else await this.stop();
  }
}

// The container's route to the platform. Assigned, not declared as a `static` class field:
// a class field (ES2022 define semantics, our TS target) creates an own property that hides
// @cloudflare/containers' `outboundByHost` setter, so its per-class registry, which
// ContainerProxy reads, stays empty and every request to platform.internal is refused (520).
SshGateway.outboundByHost = {
  [PLATFORM_HOST]: (req: Request, env: Env) => forwardToPlatform(req, env),
};

const gateway = (env: Env) => env.SSH_GATEWAYS?.get(env.SSH_GATEWAYS.idFromName(GATEWAY));

/** The Worker's `connect()` handler: inbound TCP to the gateway on the `connect` front door,
 * otherwise refused. */
export async function sshFrontDoor(socket: Socket, env: Env) {
  const stub = frontDoor(env) === 'connect' && gateway(env);
  if (!stub) {
    await socket.close().catch(() => {});
    return;
  }
  await splice(socket, stub.connect(`${GATEWAY}:22`));
}

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields }));

/** Keeps the one gateway (and its tunnel) running on the tunnel front door; nothing
 * otherwise. Called by the platform's cron and, at most once a minute per isolate, by
 * /health (sshWake), so a deploy's health check starts it without waiting for the cron. */
export async function sshKeepAlive(env: Env, by: 'cron' | 'health') {
  const stub = frontDoor(env) === 'tunnel' && gateway(env);
  if (!stub) return;
  const started = Date.now();
  try {
    const result = await stub.keepAlive();
    if (by === 'health' || result.started)
      log('ssh.keepalive', { by, started: result.started, ms: Date.now() - started });
  } catch (e) {
    console.error(
      JSON.stringify({ event: 'ssh.keepalive_failed', by, error: String(e).slice(0, 300) }),
    );
  }
}

let woken = 0;
/** /health on the tunnel front door: starts the gateway after the answer (throttled). */
export function sshWake(env: Env) {
  if (frontDoor(env) !== 'tunnel' || Date.now() - woken < 60_000) return;
  woken = Date.now();
  deferred(() => sshKeepAlive(env, 'health'));
}
