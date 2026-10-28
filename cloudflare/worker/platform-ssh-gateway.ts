// Git over SSH on Cloudflare: inbound TCP reaches this Worker's `connect()` handler
// (sshFrontDoor), which pipes the socket to an SshGateway Durable Object, which pipes it to
// its container's SSH port. The container runs `yoneda-ssh-gateway` (cloudflare/containers/
// ssh-gateway.Dockerfile): it authenticates keys and bridges Git's SSH transport onto this
// Worker's smart-HTTP endpoints. The container has no internet; its only egress is
// http://platform.internal, which `outboundByHost` hands to this Worker (SELF) for the
// /internal/ssh and /git paths alone.
//
// Public inbound TCP into Workers is not generally available (Spectrum to a Worker is in
// private beta), so SSH_FRONT_DOOR stays off until it is granted; the gateway itself runs
// and is tested locally against `wrangler dev` (tools/staging/ssh-flow.mjs).
import { Container } from '@cloudflare/containers';
import type { Env } from './types';

/** The gateway's SSH listener inside its container (unprivileged; the public port is 22). */
export const SSH_PORT = 2222;
/** Its HTTP health listener, which container start-up waits for. */
const HEALTH_PORT = 8080;
export const PLATFORM_HOST = 'platform.internal';
const PLATFORM_PATHS =
  /^\/(internal\/ssh\/(lookup|session)|git\/r[0-9a-f]{20}(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack))$/;

/** The container's request to the platform, served by this Worker; nothing else is
 * reachable from it. */
export function forwardToPlatform(req: Request, env: Env): Promise<Response> | Response {
  const url = new URL(req.url);
  if (!env.SELF || !PLATFORM_PATHS.test(url.pathname))
    return new Response('Not reachable from the SSH gateway\n', { status: 403 });
  const target = new URL(`${url.pathname}${url.search}`, 'https://platform.internal');
  return env.SELF.fetch(new Request(target, req));
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
  /** Open SSH connections: the container sleeps only when there are none. */
  private open = 0;

  static outboundByHost = {
    [PLATFORM_HOST]: (req: Request, env: Env) => forwardToPlatform(req, env),
  };

  private async ready() {
    const { SSH_GATEWAY_SECRET, SSH_HOST_ED25519_KEY, SSH_HOST_ECDSA_KEY } = this.env;
    if (!SSH_GATEWAY_SECRET || !SSH_HOST_ED25519_KEY || !SSH_HOST_ECDSA_KEY)
      throw new Error('SSH gateway secrets are not configured');
    await this.startAndWaitForPorts({
      ports: [HEALTH_PORT],
      startOptions: {
        envVars: {
          PLATFORM_URL: `http://${PLATFORM_HOST}`,
          SSH_LISTEN: `0.0.0.0:${SSH_PORT}`,
          HEALTH_LISTEN: `0.0.0.0:${HEALTH_PORT}`,
          SSH_GATEWAY_SECRET,
          SSH_HOST_ED25519_KEY,
          SSH_HOST_ECDSA_KEY,
        },
      },
      cancellationOptions: { portReadyTimeoutMS: 60_000 },
    });
  }

  /** One SSH connection, forwarded from the front door. */
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

  override async onActivityExpired() {
    if (this.open > 0) this.renewActivityTimeout();
    else await this.stop();
  }
}

/** The Worker's `connect()` handler: inbound TCP (Spectrum) to an SSH gateway, or refused
 * while the front door is off. */
export async function sshFrontDoor(socket: Socket, env: Env) {
  if (env.SSH_FRONT_DOOR !== 'on' || !env.SSH_GATEWAYS) {
    await socket.close().catch(() => {});
    return;
  }
  const instances = Math.max(1, Number(env.SSH_GATEWAY_INSTANCES) || 1);
  const name = `ssh-gateway-${Math.floor(Math.random() * instances)}`;
  const gateway = env.SSH_GATEWAYS.get(env.SSH_GATEWAYS.idFromName(name));
  const upstream = gateway.connect(`${name}:22`);
  await splice(socket, upstream);
}
