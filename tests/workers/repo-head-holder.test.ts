// The head holder's copy of main goes stale at each landing and reloads in the background, so
// a reload that fails, or that read the authority before the landing, must not end the
// staleness: the holder would serve the old head with nothing left to replace it.
import { expect, it, vi } from 'vitest';
import { HeadHolder } from '../../cloudflare/worker/repo-head-holder';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** `scoped` with an authority that can be down, or hold its answers back once it gave them. */
function gated() {
  const gate = { down: false, hold: null as Promise<void> | null, answered: 0 };
  const authority = scoped.SOURCE_REPOS;
  const held = {
    ...scoped,
    SOURCE_REPOS: {
      idFromName: (name: string) => authority.idFromName(name),
      get: (id: DurableObjectId) => ({
        fetch: async (url: string, init: RequestInit) => {
          if (gate.down) throw new Error('authority unavailable');
          const answer = await authority.get(id).fetch(url, init);
          gate.answered++;
          await gate.hold;
          return answer;
        },
      }),
    },
  } as unknown as Env;
  return { gate, held };
}

async function repository(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author },
  });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const land = async (path: string) => {
    const made = await api(`${repo}/commits`, owner, {
      body: { ref: 'main', changes: [file(path, `${path}\n`)], message: path, author },
    });
    const landed = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } });
    expect(landed.status).toBe(200);
    return landed.body.version as number;
  };
  return { id: created.body.id as string, land };
}

it('reloads after a reload that failed, rather than keep the old head for good', async () => {
  const { id, land } = await repository('head-failed-reload');
  const { gate, held } = gated();
  const holder = new HeadHolder(held);
  const before = await holder.head(id, 0);
  const version = await land('b.txt');
  expect(version).toBeGreaterThan(before.version);
  gate.down = true;
  await holder.refresh(id);
  await holder.idle();
  gate.down = false;
  await holder.head(id, 0); // The caller that finds it stale starts the reload.
  await holder.idle();
  expect((await holder.head(id, 0)).version).toBe(version);
});

it('reloads again after a load that read the authority before the landing', async () => {
  const { id, land } = await repository('head-overlapping-load');
  const { gate, held } = gated();
  const holder = new HeadHolder(held);
  const before = (await holder.head(id, 0)).version as number;
  let release = () => {};
  gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.answered = 0;
  const running = holder.refresh(id); // A load that will hold the head from before the landing.
  await vi.waitFor(() => expect(gate.answered).toBe(1));
  const version = await land('b.txt');
  expect(version).toBeGreaterThan(before);
  await holder.refresh(id); // The landing's refresh meets that load.
  gate.hold = null;
  release();
  await running;
  await holder.idle();
  expect((await holder.head(id, 0)).version).toBe(version);
});
