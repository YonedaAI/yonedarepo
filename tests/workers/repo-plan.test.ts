// Work plans (paper §3.3): a reference cycle written by two items joins them, independent
// items share a stage, a reader of another item's writes waits for it, stale reads are
// reported, and directory grants bound what a plan may name or reveal.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const A = 'export function a(n: number): number {\n  return n > 0 ? b(n - 1) : 0;\n}\n';
const B = "import { a } from './a';\n\nexport function b(n: number): number {\n  return a(n);\n}\n";
const C = 'export function c(): number {\n  return 1;\n}\n\nexport function helper(): number {\n  return c();\n}\n';

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('src/a.ts', A), file('src/b.ts', B), file('src/c.ts', C), file('src/broken.ts', 'export function (')], author },
  });
  return { owner, id: created.body.id as string, repo: `/repos/${created.body.id}` };
}

it('joins a written cycle into one item and stages the rest by Eq. 1', async () => {
  const { owner, repo } = await setup('planner');
  const items = [
    { id: 'edit-a', write_set: ['src/a.ts#a'] },
    { id: 'edit-b', write_set: ['src/b.ts#b'] },
    { id: 'edit-c', write_set: ['src/c.ts#c'] },
    { id: 'use-c', read_set: ['src/c.ts#c'], write_set: ['src/d.ts'] },
    { id: 'broken-x', write_set: ['src/broken.ts#x'] },
    { id: 'broken-y', write_set: ['src/broken.ts#y'] },
  ];
  const planned = await api(`${repo}/plans`, owner, { body: { items, closure_depth: 0 } });
  expect(planned.status).toBe(200);
  const plan = planned.body;
  expect(plan).toMatchObject({ ref: 'main', version: 1, cycles: [['src/a.ts#a', 'src/b.ts#b']] });
  expect(plan.items.map((i: any) => i.members)).toEqual([['edit-a', 'edit-b'], ['edit-c'], ['use-c'], ['broken-x'], ['broken-y']]);
  const stageOf = (id: string) => plan.items[plan.item_of[id]].stage;
  expect([stageOf('edit-a'), stageOf('edit-c'), stageOf('use-c')]).toEqual([0, 0, 1]);
  expect(plan.items[plan.item_of['use-c']].after).toEqual([plan.item_of['edit-c']]);
  // The unparseable file is planned at path level, so its two items serialize.
  expect(plan.graph.unparsed).toEqual(['src/broken.ts']);
  expect(plan.items[plan.item_of['broken-y']].write_set).toEqual(['src/broken.ts']);
  expect(stageOf('broken-y')).toBeGreaterThan(stageOf('broken-x'));

  // Closure: helper calls c, so changing helper reads c and waits for c's change.
  const closure = await api(`${repo}/plans`, owner, { body: { items: [{ id: 'h', write_set: ['src/c.ts#helper'] }, { id: 'c', write_set: ['src/c.ts#c'] }] } });
  expect(closure.body.items[0]).toMatchObject({ closure: ['src/c.ts#c'], stage: 1, after: [1] });

  // Revision-bound: after c changes, an item whose base predates it has a stale read.
  const edit = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('src/c.ts', C.replace('return 1', 'return 2'))], message: 'c', author } });
  await api(`${repo}/land`, owner, { body: { ref: 'main', commit: edit.body.commit } });
  const later = await api(`${repo}/plans`, owner, { body: { items: [{ id: 'old', base_version: 1, read_set: ['src/c.ts#c'] }, { id: 'fine', base_version: 1, read_set: ['src/c.ts#helper'] }] } });
  expect(later.body.version).toBe(2);
  expect(later.body.stale).toEqual([{ id: 'old', version: 2, entries: ['src/c.ts#c'] }]);
  const past = await api(`${repo}/plans`, owner, { body: { at: 1, items: [{ id: 'old', base_version: 1, read_set: ['src/c.ts#c'] }] } });
  expect(past.body).toMatchObject({ version: 1, stale: [] });
});

it('keeps plans inside directory grants and serves them over MCP', async () => {
  const { owner, id, repo } = await setup('plangrants');
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'contractor', scopes: ['read', 'write'], paths: ['src/c.ts', 'src/d.ts'] } });
  const contractor = { token: minted.body.token as string };
  const outside = await api(`${repo}/plans`, contractor, { body: { items: [{ id: 'x', write_set: ['src/a.ts#a'] }] } });
  expect(outside.status).toBe(403);
  expect(outside.body.error.code).toBe('FORBIDDEN');
  const inside = await api(`${repo}/plans`, contractor, { body: { items: [{ id: 'y', read_set: ['src/c.ts#c'], write_set: ['src/d.ts'] }], closure_depth: 3 } });
  expect(inside.status).toBe(200);
  const text = JSON.stringify(inside.body);
  for (const hidden of ['src/a.ts', 'src/b.ts', 'src/broken.ts']) expect(text).not.toContain(hidden);
  expect(inside.body.graph.files).toBe(1);

  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${id}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${contractor.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_plan', arguments: { items: [{ id: 'y', write_set: ['src/c.ts#c'] }] } } }),
    }),
    scoped,
  );
  const reply = await response.json<any>();
  expect(reply.result.isError).toBeUndefined();
  expect(reply.result.structuredContent.stages).toEqual([[0]]);
});
