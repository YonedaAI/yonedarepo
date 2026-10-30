// A deleted repository leaves no review behind: the platform sends repo.deleted (signed with
// the agents' hook secret), and the managed Worker deletes every transcript under
// transcripts/<repo>/ in R2 (paged, at most 1,000 keys a delete), forgets the repository in its
// workspace's settings and enabled lists, and empties its RepoAgents state (runs, findings,
// connection). Billing entries stay and carry no transcript text. The handler is at least
// once: a repeated event finds nothing left to delete.
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { workspaceStub } from '../../cloudflare/managed/workspace-agents';
import {
  fakeGateway,
  type Harness,
  HEAD_A,
  HOOK_SECRET,
  harness,
  inline,
  newRepo,
  signature,
} from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const put = (h: Harness, agent: string, body: unknown) =>
  managedFetch(
    new Request(
      `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/${agent}`,
      {
        method: 'PUT',
        headers: { cookie: 'session=owner', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    h.env,
  );
const deliver = async (h: Harness, body: QueueMessage) => {
  const message = { body, ack: vi.fn(), retry: vi.fn() };
  await consume({ messages: [message] } as unknown as MessageBatch<QueueMessage>, h.env);
  expect(message.retry).not.toHaveBeenCalled();
};
const hook = (h: Harness, payload: Record<string, unknown>, sig?: string) => {
  const body = JSON.stringify(payload);
  return (async () =>
    managedFetch(
      new Request(`https://managed.example.com/hooks/${h.platform.repo}`, {
        method: 'POST',
        headers: {
          'x-yoneda-signature': sig ?? (await signature(HOOK_SECRET, body)),
          'x-yoneda-event': String(payload.event),
        },
        body,
      }),
      h.env,
    ))();
};

/** A repository with two agents' runs done, its transcripts, and an override. */
async function reviewed() {
  const h = harness(newRepo());
  h.platform.change({ files: FIXTURES['security-review'].trigger.files });
  expect((await put(h, 'security-review', { repos: [h.platform.repo] })).status).toBe(200);
  expect(
    (
      await put(h, 'code-review', {
        repos: [h.platform.repo],
        scope: h.platform.repo,
        settings: { trigger: { when: 'push', changes: 'ready_for_review', paths: ['src/'], branches: [] } },
      })
    ).status,
  ).toBe(200);
  fakeGateway();
  h.harness.scripts = [
    {
      result: { summary: 's', findings: FIXTURES['security-review'].trigger.expected },
      calls: [{}],
      transcript: 'TRANSCRIPT-TEXT reviewing users.js',
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
  await deliver(h, opened);
  for (const run of h.created)
    expect(await runAgent(h.env, run, inline)).toMatchObject({ status: 'findings' });
  // Enough transcripts to need three pages, and another repository's that must stay.
  for (let i = 0; i < 2100; i++)
    h.transcripts.set(
      `transcripts/${h.platform.repo}/old-run/${String(i).padStart(4, '0')}.txt`,
      'x',
    );
  h.transcripts.set(
    `transcripts/${h.platform.repo}0/kept/1-0.txt`,
    'another repository (a longer id)',
  );
  h.transcripts.set('transcripts/r99999999999999999999/kept/1-0.txt', 'another repository');
  return h;
}

describe('repo.deleted', () => {
  it('deletes the transcripts, the runs and the connection, and forgets the repository', async () => {
    const h = await reviewed();
    const repo = h.platform.repo;
    expect(
      [...h.transcripts.keys()].filter((k) => k.startsWith(`transcripts/${repo}/`)).length,
    ).toBeGreaterThan(2100);
    h.platform.deleted = true;
    const res = await hook(h, {
      event: 'repo.deleted',
      action: 'deleted',
      repo,
      actor: 'user:owner',
    });
    expect(res.status).toBe(202);
    expect(h.sent).toEqual([{ kind: 'deleted', repo }]);
    await deliver(h, h.sent[0]);

    expect([...h.transcripts.keys()].filter((k) => k.startsWith(`transcripts/${repo}/`))).toEqual(
      [],
    );
    expect(h.transcripts.has(`transcripts/${repo}0/kept/1-0.txt`)).toBe(true);
    expect(h.transcripts.has('transcripts/r99999999999999999999/kept/1-0.txt')).toBe(true);
    expect(h.r2.deleteCalls.every((n) => n <= 1000)).toBe(true);
    expect(
      h.r2.listCalls.every((c) => c.prefix === `transcripts/${repo}/` && c.limit <= 1000),
    ).toBe(true);

    const stub = repoStub(h.env, repo);
    expect(await stub.connection()).toBeNull();
    expect(await stub.runs(null, 50)).toEqual([]);
    await runInDurableObject(stub as DurableObjectStub, (_i, state) => {
      for (const table of ['runs', 'agents', 'connection'])
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n, table).toBe(0);
    });
    const ws = workspaceStub(h.env, h.platform.account);
    for (const agent of ['security-review', 'code-review'] as const) {
      const stored = await ws.settings(agent);
      expect(stored.enabled).not.toContain(repo);
      expect(stored.repos[repo]).toBeUndefined();
    }
    // Billing history stays, with no transcript text in it.
    const entries = await ledgerStub(h.env, h.platform.account).entries(500);
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('TRANSCRIPT-TEXT');

    // At least once: the event again (and the queue message again) changes nothing and fails nothing.
    expect((await hook(h, { event: 'repo.deleted', action: 'deleted', repo })).status).toBe(202);
    await deliver(h, { kind: 'deleted', repo });
    expect(await stub.connection()).toBeNull();
  });

  it('acts only on a signed event for a repository the platform answers GONE for', async () => {
    const h = await reviewed();
    const repo = h.platform.repo;
    const before = h.transcripts.size;
    // Unsigned, or signed by someone else: refused while the repository is connected.
    expect(
      (await hook(h, { event: 'repo.deleted', action: 'deleted', repo }, 'sha256=00')).status,
    ).toBe(401);
    // Signed but the repository still exists (a replayed or misrouted event): nothing deleted.
    expect((await hook(h, { event: 'repo.deleted', action: 'deleted', repo })).status).toBe(202);
    await deliver(h, h.sent.at(-1) as QueueMessage);
    expect(h.transcripts.size).toBe(before);
    expect(await repoStub(h.env, repo).connection()).not.toBeNull();
    expect((await repoStub(h.env, repo).runs(null, 5)).length).toBeGreaterThan(0);
  });
});

describe('disable keeps a deletion notice', () => {
  it('replaces the agents hook with a repo-only hook, so a later deletion still cleans up', async () => {
    const h = await reviewed();
    const repo = h.platform.repo;
    await put(h, 'security-review', { repos: [] });
    await put(h, 'code-review', { repos: [] });
    // The token and the change/branch hook are gone; a hook for repo.deleted alone remains.
    expect(h.platform.revoked).toEqual(['tokens:yoneda-managed-agents', 'hooks:7']);
    expect(h.platform.hooks.at(-1)).toMatchObject({
      url: `https://managed.example.com/hooks/${repo}`,
      events: ['repo'],
    });
    const kept = await repoStub(h.env, repo).connection();
    expect(kept).toMatchObject({ revoked: true, hook_id: h.platform.hooks.at(-1).id });
    // Deleting the repository later still removes everything.
    h.platform.deleted = true;
    expect((await hook(h, { event: 'repo.deleted', action: 'deleted', repo })).status).toBe(202);
    await deliver(h, h.sent.at(-1) as QueueMessage);
    expect([...h.transcripts.keys()].filter((k) => k.startsWith(`transcripts/${repo}/`))).toEqual(
      [],
    );
    expect(await repoStub(h.env, repo).connection()).toBeNull();
  });

  it('re-enabling swaps the repo-only hook for a full one and mints a new token', async () => {
    const h = await reviewed();
    await put(h, 'security-review', { repos: [] });
    await put(h, 'code-review', { repos: [] });
    const notice = h.platform.hooks.at(-1).id;
    expect((await put(h, 'code-review', { repos: [h.platform.repo] })).status).toBe(200);
    expect(h.platform.revoked).toContain(`hooks:${notice}`);
    expect(h.platform.hooks.at(-1)).toMatchObject({ events: ['change', 'branch', 'repo'] });
    const again = await repoStub(h.env, h.platform.repo).connection();
    expect(again?.token).toMatch(/^yrp_fixture_yoneda-managed-agents-/);
  });
});
