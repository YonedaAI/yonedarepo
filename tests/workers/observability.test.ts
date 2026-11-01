// What the platform leaves in the logs when something goes wrong (docs/logging.md): every
// unexpected 500, one shape, one id across hops, and nothing that must not be there.
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const REPO = 'r0123456789abcdef0123';

/** The structured lines `spy` received, parsed. */
const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)));

/** A platform whose repository authority fails in a way no route expects. */
const broken = (message: string) =>
  ({
    ...bindings,
    BUILD_REVISION: 'abc1234',
    SOURCE_REPOS: {
      idFromName: () => {
        throw new Error(message);
      },
      idFromString: () => {
        throw new Error(message);
      },
      get: () => {
        throw new Error(message);
      },
    },
  }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

it('logs an unexpected 500 with its operation, code, repository, revision and id', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${REPO}/log?ref=main`, {
      headers: { authorization: 'Bearer yrp_abcdefghijklmnopqrstuvwxyz', 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' },
    }),
    broken('the authority fell over'),
  );
  expect(res.status).toBe(500);
  expect(lines(logged)).toEqual([
    {
      event: 'request.failed',
      level: 'error',
      request_id: '8f1c2d3e4a5b6c7d-SJC',
      repo: REPO,
      revision: 'abc1234',
      operation: 'GET /api/v1/repos/:repo/log',
      code: 'INTERNAL',
      status: 500,
      error: 'the authority fell over',
    },
  ]);
});
