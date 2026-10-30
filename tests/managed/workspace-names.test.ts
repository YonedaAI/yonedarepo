// Workspace names are account identifiers (yoneda-core::account): a username, an org name, or,
// for accounts made before email-only sign-up, an email address with dots, plus tags and other
// local-part characters. The managed API takes the name URL-encoded in its path, decodes it
// once and accepts exactly the canonical identifiers, nothing more.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { runAgent } from '../../cloudflare/managed/run';
import { fakeGateway, HEAD_A, harness, inline, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const at = (workspace: string, path = '', init: RequestInit = {}) =>
  new Request(
    `https://site.example.com/api/managed/workspaces/${encodeURIComponent(workspace)}${path}`,
    {
      ...init,
      headers: { cookie: 'session=owner', 'content-type': 'application/json' },
    },
  );

describe('email-named workspaces', () => {
  for (const workspace of ['dev.owner+agents@example.com', "o'neil%tag/x@mail.example.co.uk"])
    it(`serves ${workspace}: overview, enable, a run, runs and billing`, async () => {
      const h = harness(newRepo(), {}, workspace);
      h.platform.change({ files: FIXTURES['code-review'].trigger.files });
      const overview = await managedFetch(at(workspace), h.env);
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({ workspace, credit: { granted_usd: 5 } });
      const enabled = await managedFetch(
        at(workspace, '/agents/code-review', {
          method: 'PUT',
          body: JSON.stringify({ repos: [h.platform.repo] }),
        }),
        h.env,
      );
      expect(enabled.status).toBe(200);
      fakeGateway();
      h.harness.scripts = [
        {
          result: { summary: 's', findings: FIXTURES['code-review'].trigger.expected },
          calls: [{}],
        },
      ];
      const opened: QueueMessage = {
        kind: 'event',
        repo: h.platform.repo,
        event: 'change',
        ref: 'refs/heads/feature',
        commit: HEAD_A,
        change: 1,
        action: 'opened',
      };
      await consume(
        {
          messages: [{ body: opened, ack: vi.fn(), retry: vi.fn() }],
        } as unknown as MessageBatch<QueueMessage>,
        h.env,
      );
      expect(h.created[0].account).toBe(workspace);
      expect(await runAgent(h.env, h.created[0], inline)).toMatchObject({ status: 'findings' });
      const runs = await (await managedFetch(at(workspace, '/runs'), h.env)).json<any>();
      expect(runs.runs).toHaveLength(1);
      const billing = await (await managedFetch(at(workspace, '/billing'), h.env)).json<any>();
      expect(billing.credit.used_usd).toBeGreaterThan(0);
      expect(billing.usage).toEqual([expect.objectContaining({ agent: 'code-review', runs: 1 })]);
    });

  it('refuses names the platform never gives an account or org', async () => {
    const h = harness();
    for (const bad of [
      'Dev@Example.com',
      'two@at@example.com',
      'ab',
      '_admin',
      'x y',
      'a@localhost',
      '%E0%A4%A',
    ])
      expect((await managedFetch(at(bad), h.env)).status, bad).toBe(404);
    // A malformed escape (not a name at all) is refused, not thrown.
    const raw = new Request('https://site.example.com/api/managed/workspaces/%E0%A4%A', {
      headers: { cookie: 'session=owner' },
    });
    expect((await managedFetch(raw, h.env)).status).toBe(404);
  });
});

describe('a personal workspace with no repositories yet', () => {
  const as = (cookie: string) =>
    new Request('https://site.example.com/api/managed/workspaces/owner', { headers: { cookie } });

  it('shows its own account the agents and the starting credit', async () => {
    const h = harness(newRepo(), {}, 'owner');
    h.platform.repos.length = 0;
    const res = await managedFetch(as('session=owner'), h.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspace: 'owner', repos: [], credit: { granted_usd: 5 } });
  });

  it('still refuses anyone else', async () => {
    const h = harness(newRepo(), {}, 'owner');
    h.platform.repos.length = 0;
    const res = await managedFetch(as('session=reader'), h.env);
    expect(res.status).toBe(403);
  });
});
