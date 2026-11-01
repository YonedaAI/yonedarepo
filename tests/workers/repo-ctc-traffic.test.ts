// CTC's traffic through the real authority (workerd): a session hears which open Landing is on
// the file it reads, at its start and through MCP, its own Landing is left out, a delivered
// warning is not repeated, a path-limited token is refused the whole read, and `/ctc` shows the
// radar to a reader with the line and the overlaps.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy: { required_checks: [], approvals: 1 }, files: [file('src/a.rs', 'a\n')], author },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const mint = async (label: string, scopes: string[], paths?: string[]) => ({
    token: (await api(`${repo}/tokens`, owner, { body: { name: label, scopes, paths } })).body
      .token as string,
  });
  const main = (await api(`${repo}/refs`, owner)).body.refs['refs/heads/main'] as string;
  return {
    owner,
    id: created.body.id as string,
    repo,
    main,
    bot: await mint('bot', ['read', 'write']),
    docs: await mint('docs', ['read', 'write'], ['docs/']),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function landing(s: Setup, branch: string, path: string) {
  const change = [{ ...file(path, `${branch}\n`) }];
  const made = await api(`${s.repo}/commits`, s.bot, {
    body: { parent: s.main, base_version: 1, message: 'work', author, changes: change },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const moved = await api(`${s.repo}/refs/batch`, s.bot, {
    body: { updates: [{ ref: branch, commit: made.body.commit, expected: null }] },
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const opened = await api(`${s.repo}/changes`, s.bot, { body: { branch, title: `On ${branch}` } });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return opened.body.number as number;
}

async function mcp(id: string, token: string, name: string, args: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${id}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    scoped,
  );
  return (await response.json()) as { result: { structuredContent: Record<string, any> } };
}

it('warns a session at its start and when it reads a file, over REST and MCP', async () => {
  const s = await setup('traffic-warns');
  const number = await landing(s, 'fix', 'src/net.rs');
  const start = await api(`${s.repo}/context?paths=src/net.rs`, s.bot);
  expect(start.status).toBe(200);
  expect(start.body.traffic.warnings).toEqual([
    expect.objectContaining({ landing: number, overlap: 'file', path: 'src/net.rs', title: 'On fix' }),
  ]);
  const read = await api(`${s.repo}/context/relevant?paths=src/net.rs&types=memory,contract`, s.bot);
  expect(read.body.traffic.warnings.map((w: { landing: number }) => w.landing)).toEqual([number]);
  const own = await api(`${s.repo}/context/relevant?paths=src/net.rs&branch=fix`, s.bot);
  expect(own.body.traffic.warnings).toEqual([]);
  const tool = await mcp(s.id, s.bot.token, 'git_context_relevant', {
    paths: ['src/net.rs'],
    branch: 'other',
  });
  expect(tool.result.structuredContent.traffic.warnings).toHaveLength(1);
  const started = await mcp(s.id, s.bot.token, 'git_context', {
    symbols: ['src/net.rs#retry'],
  });
  expect(started.result.structuredContent.traffic.warnings).toHaveLength(1);
});

it('does not repeat a warning a session was shown', async () => {
  const s = await setup('traffic-once');
  const number = await landing(s, 'fix', 'src/net.rs');
  const ask = `${s.repo}/context/relevant?paths=src/net.rs&session_id=s1`;
  expect((await api(ask, s.bot)).body.traffic.warnings).toHaveLength(1);
  const told = await api(`${s.repo}/context/deliveries`, s.bot, {
    body: {
      session_id: 's1',
      trigger: 'read',
      subject: 'src/net.rs',
      items: [{ type: 'traffic', id: number, path: 'src/net.rs' }],
      bytes: 80,
    },
  });
  expect(told.status, JSON.stringify(told.body)).toBe(200);
  expect((await api(ask, s.bot)).body.traffic.warnings).toEqual([]);
});

it('gives a path-limited token no traffic and no radar', async () => {
  const s = await setup('traffic-grants');
  await landing(s, 'fix', 'src/net.rs');
  for (const path of ['/context?paths=src/net.rs', '/context/relevant?paths=src/net.rs', '/ctc']) {
    const refused = await api(`${s.repo}${path}`, s.docs);
    expect(refused.status, path).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('src/net.rs');
  }
});

it('shows the radar, with overlaps, and an empty one', async () => {
  const s = await setup('traffic-radar');
  expect((await api(`${s.repo}/ctc`, s.bot)).body).toEqual({
    land_when_cleared: false,
    landings: [],
    truncated: false,
  });
  const first = await landing(s, 'one', 'src/net.rs');
  const second = await landing(s, 'two', 'src/net.rs');
  const seen = await api(`${s.repo}/ctc?limit=10`, s.bot);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  const rows = seen.body.landings as Record<string, any>[];
  expect(rows.map((l) => l.number)).toEqual([first, second]);
  expect(rows[0].decision).toBe('hold');
  expect(rows[0].place).toEqual({ position: 1, line: 'waiting', ticket: null });
  expect(rows[0].overlaps).toEqual([
    { landing: second, overlap: 'file', paths: ['src/net.rs'], symbols: [] },
  ]);
  const tool = await mcp(s.id, s.bot.token, 'git_ctc_radar', { limit: 1 });
  expect(tool.result.structuredContent.truncated).toBe(true);
});
