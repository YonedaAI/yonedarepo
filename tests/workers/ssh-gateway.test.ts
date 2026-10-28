// The SSH gateway's Cloudflare wiring that runs without a container: the container's only
// egress (the platform's /internal/ssh and Git paths, through SELF), its start environment
// per front door, the `connect` front door (refused unless chosen) and the tunnel's
// keep-alive cron (only on the tunnel).
import { ContainerProxy } from '@cloudflare/containers';
import { expect, it } from 'vitest';
import {
  forwardToPlatform,
  SshGateway,
  frontDoor,
  gatewayStart,
  sshFrontDoor,
  sshKeepAlive,
} from '../../cloudflare/worker/platform-ssh-gateway';
import type { Env } from '../../cloudflare/worker/types';

const REPO = `r${'0'.repeat(20)}`;

it('forwards only the gateway paths to the platform', async () => {
  const seen: string[] = [];
  const env = {
    SELF: { fetch: async (req: Request) => (seen.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`), new Response('ok')) },
  } as unknown as Env;
  const forwarded = [
    ['POST', '/internal/ssh/lookup'],
    ['POST', '/internal/ssh/session'],
    ['POST', '/internal/ssh/status'],
    ['GET', `/git/${REPO}.git/info/refs?service=git-upload-pack`],
    ['POST', `/git/${REPO}.git/git-upload-pack`],
    ['POST', `/git/${REPO}/git-receive-pack`],
  ];
  for (const [method, path] of forwarded) {
    const response = await forwardToPlatform(new Request(`http://platform.internal${path}`, { method, body: method === 'POST' ? '{}' : undefined }), env);
    expect(response.status, path).toBe(200);
  }
  expect(seen).toEqual(forwarded.map(([method, path]) => `${method} ${path}`));
  for (const path of ['/api/v1/repos', '/internal/ssh/other', `/git/${REPO}.git/info/lfs/objects/batch`, '/api/auth/login', '/'])
    expect((await forwardToPlatform(new Request(`http://platform.internal${path}`), env)).status, path).toBe(403);
  expect((await forwardToPlatform(new Request('http://platform.internal/internal/ssh/lookup'), {} as Env)).status).toBe(403);
});

const secrets = {
  SSH_GATEWAY_SECRET: 's'.repeat(32),
  SSH_HOST_ED25519_KEY: 'ed25519 key file',
  SSH_HOST_ECDSA_KEY: 'ecdsa key file',
};

it('starts the gateway with cloudflared and the internet only on the tunnel', () => {
  expect([undefined, 'off', 'on', 'tunnel', 'connect'].map((v) => frontDoor({ SSH_FRONT_DOOR: v } as Env))).toEqual([
    null,
    null,
    null,
    'tunnel',
    'connect',
  ]);
  const connect = gatewayStart({ ...secrets, SSH_TUNNEL_TOKEN: 'token' } as unknown as Env, 'connect');
  expect(connect.enableInternet).toBe(false);
  expect(connect.envVars).toEqual({
    PLATFORM_URL: 'http://platform.internal',
    SSH_LISTEN: '0.0.0.0:2222',
    HEALTH_LISTEN: '0.0.0.0:8080',
    ...secrets,
  });
  const tunnel = gatewayStart({ ...secrets, SSH_TUNNEL_TOKEN: 'token' } as unknown as Env, 'tunnel');
  expect(tunnel.enableInternet).toBe(true);
  expect(tunnel.envVars).toMatchObject({ TUNNEL_TOKEN: 'token', TUNNEL_TRANSPORT_PROTOCOL: 'http2' });
  expect(() => gatewayStart(secrets as unknown as Env, 'tunnel')).toThrow(/SSH_TUNNEL_TOKEN/);
  expect(() => gatewayStart({} as Env, 'connect')).toThrow(/secrets/);
});

it('takes inbound TCP only on the connect front door, and keeps the gateway alive only on the tunnel', async () => {
  let closed = 0;
  const asked: string[] = [];
  const socket = { close: async () => void closed++ } as unknown as Socket;
  const stub = { keepAlive: async () => (asked.push('keepAlive'), { started: true }), connect: () => asked.push('connect') };
  const namespace = { idFromName: (name: string) => (asked.push(name), name), get: () => stub };
  for (const door of [undefined, 'off', 'tunnel']) await sshFrontDoor(socket, { SSH_FRONT_DOOR: door, SSH_GATEWAYS: namespace } as unknown as Env);
  await sshFrontDoor(socket, { SSH_FRONT_DOOR: 'connect' } as unknown as Env);
  expect([closed, asked]).toEqual([4, []]);
  for (const door of [undefined, 'off', 'connect']) await sshKeepAlive({ SSH_FRONT_DOOR: door, SSH_GATEWAYS: namespace } as unknown as Env, 'cron');
  expect(asked).toEqual([]);
  await sshKeepAlive({ SSH_FRONT_DOOR: 'tunnel', SSH_GATEWAYS: namespace } as unknown as Env, 'cron');
  expect(asked).toEqual(['ssh-gateway-0', 'keepAlive']);
  // A failed keep-alive is logged, never thrown into the cron.
  const failing = { ...namespace, get: () => ({ keepAlive: async () => Promise.reject(new Error('capacity')) }) };
  await sshKeepAlive({ SSH_FRONT_DOOR: 'tunnel', SSH_GATEWAYS: failing } as unknown as Env, 'health');
});

it("routes the container's platform.internal requests to the platform (ContainerProxy)", async () => {
  // ContainerProxy finds a class's handlers in the registry the static setter fills; a
  // `static outboundByHost = …` field would hide the setter and leave it empty (HTTP 520).
  expect(Object.hasOwn(SshGateway, 'outboundByHost')).toBe(false);
  const seen: string[] = [];
  const env = { SELF: { fetch: async (req: Request) => (seen.push(new URL(req.url).pathname), new Response('ok')) } };
  const props = { className: 'SshGateway', containerId: 'c', enableInternet: false };
  const proxy = new ContainerProxy({ props, waitUntil: () => {} } as never, env as never);
  const lookup = await proxy.fetch(new Request('http://platform.internal/internal/ssh/lookup', { method: 'POST', body: '{}' }));
  expect([lookup.status, seen]).toEqual([200, ['/internal/ssh/lookup']]);
  // Anything else the container asks for is refused.
  expect((await proxy.fetch(new Request('http://example.com/'))).status).toBe(520);
  expect((await proxy.fetch(new Request('http://platform.internal/api/v1/repos'))).status).toBe(403);
});
