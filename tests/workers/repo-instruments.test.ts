// A change's instruments through the real authority (workerd), behind LANDING_INSTRUMENTS: the
// last heads' check values and a Risk score from each head's diff, read by a collaborator and
// a public reader alike, the same twice, and nothing at all with the switch off.
import { expect, it } from 'vitest';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, LANDING_INSTRUMENTS: 'on' } as typeof scoped;
const read = (path: string, token?: string) => api(path, token ? { token } : {}, {}, on);

async function setUp(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const repo = created.body.id as string;
  const mint = async (who: string, scopes: string[]) => (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: who, scopes } })).body.token as string;
  const main = (await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main'] as string;
  return { cookie, repo, main, agent: await mint('agent', ['read', 'write', 'check']), reader: await mint('reader', ['read']) };
}

/** A server-side commit on `branch`, moving it there. */
async function commit(s: Awaited<ReturnType<typeof setUp>>, parent: string, expected: string | null, branch: string, files: unknown[]) {
  const made = await api(`/repos/${s.repo}/commits`, { token: s.agent }, { body: { parent, base_version: 1, message: 'work', author, changes: files } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.commit as string;
  const moved = await api(`/repos/${s.repo}/refs/batch`, { token: s.agent }, { body: { updates: [{ ref: branch, commit: id, expected }] } });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  return id;
}

const check = (s: Awaited<ReturnType<typeof setUp>>, commitId: string, value: string) =>
  api(`/repos/${s.repo}/commits/${commitId}/checks`, { token: s.agent }, { body: { name: 'slop-review', status: 'pass', evidence: { agent: 'slop-review', value } } });

it('reads Slop from check evidence and scores Risk from the diff, the same twice', async () => {
  const s = await setUp('instruments_read');
  const first = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  const second = await commit(s, first, first, 'fix', [file('.github/workflows/ci.yml', 'on: push\n')]);
  await api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch: 'fix', title: 'Retry' } });
  expect((await check(s, first, 'medium')).status).toBe(200);
  expect((await check(s, second, 'low')).status).toBe(200);

  const path = `/repos/${s.repo}/changes/1/instruments`;
  const seen = await read(path, s.reader);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  expect(seen.body.heads.map((h: any) => h.commit)).toEqual([second, first]);
  expect(seen.body.heads.map((h: any) => h.checks[0].value)).toEqual(['low', 'medium']);
  const [head, older] = seen.body.heads;
  const why = Object.fromEntries(head.risk.reasons.map((r: any) => [r.input, r]));
  expect(why.size.why).toBe('2 files, 2 lines');
  expect(why.sensitive.why).toContain('.github/workflows/ci.yml');
  expect(why.sensitive.points).toBeGreaterThan(0);
  // Server-side commits are classified as they are built, so this reads no unclassified points.
  expect(head.risk.score).toBeGreaterThan(older.risk.score);

  const again = await read(path, s.reader);
  expect(again.body).toEqual(seen.body);
  // The change's page learns the read exists from the change itself.
  expect((await read(`/repos/${s.repo}/changes/1`, s.reader)).body.instruments).toBe(true);
});

it('reads for a public reader with no credentials, and refuses a stranger on a private repo', async () => {
  const s = await setUp('instruments_public');
  const head = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  await api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch: 'fix', title: 'Retry' } });
  await check(s, head, 'high');
  const path = `/repos/${s.repo}/changes/1/instruments`;
  // Private: to someone with no credentials the repository is not there.
  expect((await read(path)).status).toBe(404);
  const shown = await api(`/repos/${s.repo}/visibility`, { cookie: s.cookie }, { method: 'PUT', body: { visibility: 'public' } });
  expect(shown.status, JSON.stringify(shown.body)).toBe(200);
  const open = await read(path);
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  expect(open.body.heads[0].checks).toEqual([{ name: 'slop-review', value: 'high', recorded_at: expect.any(Number) }]);
  expect(open.body.heads[0].risk.level).toBeDefined();
});

it('shares one budget: the newest head scores what it could not measure, an older head has no score', async () => {
  const s = await setUp('instruments_budget');
  const many = Array.from({ length: 205 }, (_, n) => file(`src/f${n}.ts`, `export const n = ${n};\n`));
  const first = await commit(s, s.main, null, 'fix', many);
  const second = await commit(s, first, first, 'fix', [file('src/last.ts', 'export {};\n')]);
  await api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch: 'fix', title: 'Many' } });
  const seen = await read(`/repos/${s.repo}/changes/1/instruments`, s.reader);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  const [newest, older] = seen.body.heads;
  expect(newest.commit).toBe(second);
  const size = newest.risk.reasons.find((r: any) => r.input === 'size');
  expect(size.why).toBe('206 files, at least 200 lines, 6 not measured');
  expect(older).toMatchObject({ commit: first, risk: null });
});

it('has no route and no flag with the switch off', async () => {
  const s = await setUp('instruments_off');
  await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  await api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch: 'fix', title: 'Retry' } });
  const off = await api(`/repos/${s.repo}/changes/1/instruments`, { token: s.reader });
  expect(off.status).toBe(404);
  const shown = await api(`/repos/${s.repo}/changes/1`, { token: s.reader });
  expect(shown.status).toBe(200);
  expect(shown.body).not.toHaveProperty('instruments');
});

it('answers no heads for a change whose branch is gone', async () => {
  const s = await setUp('instruments_gone');
  const head = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  await api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch: 'fix', title: 'Retry' } });
  const gone = await api(`/repos/${s.repo}/refs/batch`, { token: s.agent }, { body: { updates: [{ ref: 'fix', commit: null, expected: head }] } });
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const seen = await read(`/repos/${s.repo}/changes/1/instruments`, s.agent);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  expect(seen.body.heads).toEqual([]);
});
