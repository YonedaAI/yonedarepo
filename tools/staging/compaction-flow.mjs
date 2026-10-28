// Log compaction live gate for the staging kit (item 20, zero model spend). A fresh
// repository's log is grown to 20,000 versions through the bulk ref path (POST
// /refs/batch: 100 branch moves, so 100 log versions, per authority transaction; 200
// calls), then the owner's trigger (POST /compact) runs until nothing is due. The SQL tail
// must hold at most the default bound (10,000 versions) plus one segment (1,024), and
// `log --at 5` and refs at version 5 must answer as they did before, now from the R2
// segment. The repository is deleted afterwards, pass or fail (its segments with it).
//
// Usage: node tools/staging-realworld.mjs --only 0,20 [--compaction-versions 20000]
import assert from 'node:assert/strict';
import { b64 } from './client.mjs';
import { withRepos } from './platform-flow.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const BRANCHES = 100;
const KEEP_VERSIONS = 10_000;
const SEGMENT_VERSIONS = 1_024;

export const compactionFlow = (platform, metrics, { versions = 20_000 } = {}) =>
  withRepos(platform, (newRepo) => compaction(platform, newRepo, metrics, versions));

async function compaction(platform, newRepo, metrics, target) {
  const repo = await newRepo('kit-compact', { required_checks: [], approvals: 0 }, [{ path: 'a.txt', content_b64: b64('a\n') }]);
  const path = `/repos/${repo.id}`;
  const root = repo.commit;
  const child = (await platform.post(`${path}/commits`, { parent: root, changes: [{ path: 'b.txt', content_b64: b64('b\n') }], message: 'Kit compaction', author })).commit;

  // Each batch moves every branch to the other commit: 100 versions per call.
  const at = Array(BRANCHES).fill(null);
  let version = (await platform.get(path)).version;
  const grow = performance.now();
  while (version < target) {
    const take = Math.min(BRANCHES, target - version);
    const updates = at.slice(0, take).map((was, i) => {
      at[i] = was === root ? child : root;
      return { ref: `b${i}`, commit: at[i], expected: was };
    });
    version = (await platform.post(`${path}/refs/batch`, { updates })).version;
  }
  metrics.versions = version;
  metrics.grow_s = ((performance.now() - grow) / 1000).toFixed(1);
  const logBefore = await platform.get(`${path}/log?ref=b3&at=5`);
  assert.equal(logBefore.commits[0]?.commit, root, 'b3 was created at the root at version 5');

  // The owner's trigger moves at most 8 segments a run; run it until nothing is due.
  const compact = performance.now();
  let result = { more: true };
  let segments = 0;
  for (let run = 0; result.more && run < 10; run++) {
    result = await platform.post(`${path}/compact`, {});
    segments += result.segments;
  }
  Object.assign(metrics, {
    segments,
    floor: result.floor,
    tail_rows: result.tail_rows,
    compact_s: ((performance.now() - compact) / 1000).toFixed(1),
  });
  assert.equal(result.more, false, 'compaction finished');
  assert.equal(result.head, version);
  assert.ok(result.floor >= 5, `versions up to ${result.floor} archived (version 5 among them)`);
  assert.ok(result.tail_rows <= KEEP_VERSIONS + SEGMENT_VERSIONS, `SQL tail ${result.tail_rows} rows is bounded`);
  assert.equal(result.tail_rows, version - result.floor);

  // Reads below the floor answer from the archived segment, as before.
  const read = performance.now();
  const logAfter = await platform.get(`${path}/log?ref=b3&at=5`);
  metrics.log_at_5_ms = Math.round(performance.now() - read);
  assert.deepEqual(logAfter, logBefore);
  const refs = await platform.get(`${path}/refs?at=5`);
  assert.equal(refs.refs['refs/heads/b3'], root);
  assert.equal(refs.refs['refs/heads/b4'], undefined, 'b4 is created after version 5');
}
