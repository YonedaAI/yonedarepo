// Automatic Landings cost nothing: a push's own row (`origin` = auto) starts no run unless the
// repository turned that on, whichever event or button points at it. On a rollback the fields
// may be missing: no `landings` in status means off, and an old list's rows are filtered here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { fakeGateway, HEAD_A, HEAD_B, type Harness, harness } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const api = (h: Harness, path: string, init: RequestInit = {}) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}${path}`, {
      ...init,
      headers: { cookie: 'session=owner', 'content-type': 'application/json' },
    }),
    h.env,
  );
const put = (h: Harness, body: unknown) => api(h, '/agents/code-review', { method: 'PUT', body: JSON.stringify(body) });
const pushed = (h: Harness, commit = HEAD_A, extra: Partial<QueueMessage> = {}): QueueMessage =>
  ({
    kind: 'event',
    repo: h.platform.repo,
    event: 'branch',
    ref: 'refs/heads/feature',
    commit,
    change: null,
    action: 'moved',
    ...extra,
  }) as QueueMessage;
async function deliver(h: Harness, ...bodies: QueueMessage[]) {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  await consume({ messages } as unknown as MessageBatch<QueueMessage>, h.env);
  for (const m of messages) expect(m.retry).not.toHaveBeenCalled();
}

async function connected() {
  const h = harness();
  const files = FIXTURES['code-review'].trigger.files;
  h.platform.change({ origin: 'auto', files, created_at: 5_000 });
  expect((await put(h, { repos: [h.platform.repo] })).status).toBe(200);
  fakeGateway();
  return h;
}

describe('agents on automatic Landings', () => {
  it('starts nothing for an auto row with the switch off', async () => {
    const h = await connected();
    h.platform.autoAgents = false;
    await deliver(h, pushed(h));
    expect(h.created).toHaveLength(0);
  });

  it('starts nothing on a platform that has no switch yet, even if its list is unfiltered', async () => {
    const h = await connected();
    h.platform.ignoresListFilters = true;
    await deliver(h, pushed(h));
    expect(h.created).toHaveLength(0);
  });

  it('Run now skips auto rows with the switch off', async () => {
    const h = await connected();
    const res = await api(h, '/agents/code-review/run', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ started: 0 });
    expect(h.created).toHaveLength(0);
  });

  it('still reviews an explicit change at that head', async () => {
    const h = await connected();
    h.platform.change({ origin: 'explicit', files: FIXTURES['code-review'].trigger.files });
    await deliver(h, pushed(h));
    expect(h.created).toHaveLength(1);
  });

  it('asks the platform for one branch, so 200 other open rows cannot hide it', async () => {
    const h = await connected();
    h.platform.autoAgents = false;
    await deliver(h, pushed(h, HEAD_B));
    const asked = h.platform.requests.filter((r) => r.path.includes('/changes?')).map((r) => new URL(`https://x${r.path}`).searchParams);
    expect(asked.at(-1)?.get('branch')).toBe('feature');
    expect(asked.at(-1)?.get('origin')).toBe('explicit');
  });
});
