// Log compaction through the real SourceRepository DO and R2: the owner's trigger moves a
// segment of old versions to R2, the SQL tail shrinks, reads at old versions still answer
// (from the segment the adapter fetches), and a corrupted segment is refused.
import { expect, it } from 'vitest';
import { compactAfterLanding } from '../../cloudflare/worker/repo-compaction';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** A repository whose log has passed 1,100 versions: 100 branches moved in batches. */
async function grown(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name: 'long-log', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author, tokens: [{ name: 'agent', scopes: ['read', 'write'] }] },
  });
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const agent = { token: created.body.tokens[0].token };
  const root = created.body.commit as string;
  const child = (await api(`${repo}/commits`, agent, { body: { parent: root, changes: [file('b.txt', 'b\n')], message: 'b', author } })).body.commit;
  const at: (string | null)[] = Array(100).fill(null);
  let version = (await api(repo, owner)).body.version as number;
  while (version < 1_100) {
    const updates = at.map((was, i) => {
      at[i] = was === root ? child : root;
      return { ref: `b${i}`, commit: at[i], expected: was };
    });
    const moved = await api(`${repo}/refs/batch`, agent, { body: { updates } });
    expect(moved.status).toBe(200);
    version = moved.body.version;
  }
  return { owner, agent, id, repo, root, version };
}

it('moves old versions to R2 segments and still answers reads at them', async () => {
  const { owner, agent, id, repo, root, version } = await grown('compactor');
  const refsAt5 = (await api(`${repo}/refs?at=5`, owner)).body.refs;
  const logAt5 = (await api(`${repo}/log?ref=b3&at=5`, owner)).body;
  expect(logAt5.commits[0].commit).toBe(root);

  // Defaults keep 10,000 versions; the owner lowers the bound. Only the owner may.
  expect((await api(`${repo}/compact`, owner, { body: {} })).body.segments).toBe(0);
  expect((await api(`${repo}/retention`, agent, { method: 'PUT', body: { keep_versions: 64 } })).status).toBe(403);
  expect((await api(`${repo}/compact`, agent, { body: {} })).status).toBe(403);
  const bound = await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  expect(bound.body).toEqual({ keep_versions: 64, keep_days: 30 });

  const compacted = await api(`${repo}/compact`, owner, { body: {} });
  expect(compacted.status).toBe(200);
  expect(compacted.body).toMatchObject({ segments: 1, floor: 1_024, head: version, tail_rows: version - 1_024, more: false });
  const listed = await bindings.OBJECTS.list({ prefix: `platform/v1/${id}/_log/` });
  expect(listed.objects.map((o) => o.key.split('/_log/')[1]).sort()).toEqual([
    'checkpoint-00000000000000000000.json',
    'segment-00000000000000000000-00000000000000001024.json',
  ]);

  // Reads below the floor answer from the segment; the tail from the anchor.
  expect((await api(`${repo}/log?ref=b3&at=5`, owner)).body).toEqual(logAt5);
  expect((await api(`${repo}/refs?at=7`, owner)).body.refs['refs/heads/b5']).toBe(root);
  expect((await api(`${repo}/refs?at=1050`, owner)).status).toBe(200);
  expect(refsAt5['refs/heads/b3']).toBe(root);

  // A segment altered in R2 is refused, not replayed.
  const key = `platform/v1/${id}/_log/segment-00000000000000000000-00000000000000001024.json`;
  const good = await (await bindings.OBJECTS.get(key))!.text();
  await bindings.OBJECTS.put(key, good.replace(/"version":9(?=[,}])/, `"version":10`));
  const refused = await api(`${repo}/log?ref=b3&at=9`, owner);
  expect(refused.body.error.code).toBe('ARCHIVE_CORRUPT');
  await bindings.OBJECTS.put(key, good);
  expect((await api(`${repo}/log?ref=b3&at=9`, owner)).status).toBe(200);
});

it('runs after landings as the platform, within the repository bound', async () => {
  const { owner, repo, id, version } = await grown('landing_compactor');
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  // The derive job's run moves the due segment with the platform's compaction role.
  expect(await compactAfterLanding(scoped, id, version)).toMatchObject({ segments: 1, floor: 1_024 });
  expect((await api(`${repo}/log?ref=b3&at=5`, owner)).status).toBe(200);
  // Then it waits out its window, and a small log is never checked at all.
  expect(await compactAfterLanding(scoped, id, version)).toBeNull();
  expect(await compactAfterLanding(scoped, 'r00000000000000000000', 10)).toBeNull();
});
