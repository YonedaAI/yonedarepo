// The SSH gateway's Cloudflare wiring that runs without a container: the container's only
// egress (the platform's /internal/ssh and Git paths, through SELF), and the front door,
// which refuses inbound TCP while SSH_FRONT_DOOR is off.
import { expect, it } from 'vitest';
import { forwardToPlatform, sshFrontDoor } from '../../cloudflare/worker/platform-ssh-gateway';
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

it('closes inbound TCP while the front door is off', async () => {
  let closed = 0;
  let gateways = 0;
  const socket = { close: async () => void closed++ } as unknown as Socket;
  const namespace = { idFromName: () => (gateways++, 'id'), get: () => ({}) };
  await sshFrontDoor(socket, { SSH_GATEWAYS: namespace } as unknown as Env);
  await sshFrontDoor(socket, { SSH_FRONT_DOOR: 'on' } as unknown as Env);
  expect([closed, gateways]).toEqual([2, 0]);
});
