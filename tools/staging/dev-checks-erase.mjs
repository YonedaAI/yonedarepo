// The large-repo erase soak, live on dev (dev-checks.mjs). A new public repository takes a pinned
// open-source history through stock `git push`, in the checkpoints `size-ladder.mjs --plan-only`
// planned, then reads fill its derived caches and a commit, a release and a transcript add what a
// push does not. It is deleted and left to the window, the sweep, the purge and the erase, with
// the erase's own log lines tailed for its jobs. Then every copy is read from outside: D1, each
// R2 prefix and the object, each of which must have held something first.
// A commit shard or a combiner has no outside view, so they are shown by the log line that follows
// their clearing, and the Cache API by reads alone: neither counts as proven.
import assert from 'node:assert/strict';
import { eraseCost, eraseRequests } from './dev-checks-cost.mjs';
import { copiesLeft, eraseStory, limitsBroken, parseTail, proofTable, shortWindow, unseen } from './dev-checks-lib.mjs';
import { author, fileOf, locateObject, newRepo, noteStore, repoPath, refused, remove, snapshot, waitErased, waitFor } from './dev-checks-repos.mjs';

/** Analytics trail what they count by minutes. */
const ANALYTICS_LAG_MS = 300_000;
const TRANSCRIPT = { turns: [{ kind: 'prompt', text: 'Dev check: a transcript to erase.' }, { kind: 'reply', text: 'Written, then erased.' }] };

/** Reads and writes that fill what a repository derives, each noted, none fatal: an hour of
 * import should not end on one read, and the proof table shows which copies a run really made. */
async function fillCaches(ctx, repo, rung, m) {
  const path = (rest) => repoPath(repo, rest);
  const query = encodeURIComponent(rung.query);
  const file = encodeURIComponent(rung.path);
  const reads = {
    tree: path('/tree?ref=main'),
    file: path(`/blob?path=${file}`),
    search: path(`/search?q=${query}&ref=main`),
    symbols: path(`/symbols?ref=main&path=${file}`),
    overview: path('/views/human?path=&ref=main'),
    blame: path(`/blame?path=${file}`),
  };
  m.reads = {};
  for (const [name, url] of Object.entries(reads)) m.reads[name] = (await ctx.owner.raw('GET', url)).status;
  const edge = [await ctx.anon.raw('GET', reads.file), await ctx.anon.raw('GET', reads.file)].at(-1);
  m.colo = (edge.headers?.get?.('cf-ray') ?? '').split('-')[1] ?? null;
  m.writes = {};
  const attempt = async (name, work) => {
    m.writes[name] = await work().then(() => 'ok', (e) => String(e?.message ?? e).slice(0, 200));
  };
  const main = (await ctx.owner.get(path('/refs'))).refs['refs/heads/main'];
  await attempt('commit and landing', async () => {
    const { commit } = await ctx.owner.post(path('/commits'), { ref: 'main', changes: [fileOf('dev-check.txt', 'Written by the erase check.\n')], message: 'Dev check', author });
    await ctx.owner.post(path('/land'), { ref: 'main', commit });
    await ctx.owner.post(path(`/commits/${commit}/sessions`), { cli: 'claude-code', model: 'none', summary: 'A dev check.', transcript: TRANSCRIPT });
  });
  await attempt('release and asset', async () => {
    await ctx.owner.post(path('/tags'), { name: 'dev-check', commit: main });
    await ctx.owner.post(path('/releases'), { tag: 'dev-check', title: 'Dev check' });
    const { status } = await ctx.asset(repo, 'dev-check', 'erase.bin', Buffer.alloc(4096, 7));
    assert.equal(status, 200, `the asset: ${status}`);
  });
  const clone = await ctx.git.fullClone(repo, repo.token);
  m.clone = clone.ok ? { ms: clone.ms, head: clone.head } : { error: clone.error };
  return reads;
}

/** Copies a real repository always has: a row that saw nothing means the probe looked in the wrong place. */
const unproven = (rows) => rows.filter((r) => r.verdict === 'not exercised' && !r.copy.startsWith('d1 ') && !r.copy.startsWith('r2 store/'));

export function eraseSteps(ctx, { rung, checkpoints, source, importMs, eraseMs }) {
  const s = {};
  return [
    ['E1', `Import ${rung.name} with ${checkpoints.length} pushes`, async (m) => {
      s.window = shortWindow((await ctx.owner.get('/repos/deleted')).window_days);
      m.window = s.window.label;
      s.repo = await newRepo(ctx, `large-${rung.name}`, { visibility: 'public' });
      const minted = await ctx.owner.post(repoPath(s.repo, '/tokens'), { name: 'dev-check', scopes: ['read', 'write', 'land'] });
      ctx.secrets.add(minted.token);
      s.repo.token = minted.token;
      const started = ctx.clock.now();
      let pushed = 0;
      for (const checkpoint of checkpoints) {
        if (ctx.clock.now() - started > importMs) break;
        const done = await ctx.git.pushAt(source, s.repo, checkpoint, minted.token);
        if (!done.ok) {
          m.stopped = done.error;
          break;
        }
        pushed++;
      }
      assert.ok(pushed > 0, `no push landed: ${m.stopped}`);
      await noteStore(ctx, s.repo);
      Object.assign(m, { repo: s.repo.id, pushes: pushed, planned: checkpoints.length, import_s: Math.round((ctx.clock.now() - started) / 1000), store: s.repo.store });
    }],
    ['E2', 'Fill its derived caches, shards, release and transcript', async (m) => {
      s.reads = await fillCaches(ctx, s.repo, rung, m);
    }],
    ['E3', 'Every copy, before', async (m) => {
      s.before = await snapshot(ctx, s.repo);
      const keys = Object.values(s.before.r2).reduce((n, p) => n + p.keys, 0);
      const bytes = Object.values(s.before.r2).reduce((n, p) => n + p.bytes, 0);
      assert.ok(keys > 0, 'R2 holds its objects');
      s.keys = keys;
      s.prefixes = Object.keys(s.before.r2).length;
      s.refs = Object.keys((await ctx.owner.get(repoPath(s.repo, '/refs'))).refs).length;
      Object.assign(m, { r2_keys: keys, r2_mib: Math.round(bytes / 1048576), kinds: Object.fromEntries(Object.entries(s.before.r2).map(([p, seen]) => [p, seen.kinds])) });
    }],
    ['E4', 'Delete it and wait out the window, the sweep, the purge and the erase', async (m) => {
      s.tail = await ctx.tail(s.repo);
      await remove(ctx, s.repo);
      s.deleted = ctx.clock.now();
      await locateObject(ctx, s.repo);
      const at = await ctx.owner.get('/repos/deleted');
      const due = at.repos.find((r) => r.id === s.repo.id)?.purge_at;
      assert.ok(due, 'it is on the schedule');
      s.object = await ctx.operator.post('/admin/erase-backfill', { object: s.repo.object, dry_run: true });
      assert.equal(s.object.state, 'tombstone', 'a tombstone');
      m.db_mib = Math.round((s.object.db_bytes ?? 0) / 1048576);
      const left = due - ctx.clock.now();
      if (left > 0) await ctx.clock.sleep(left);
      await waitFor(ctx, async () => (await ctx.cf.d1('SELECT COUNT(*) AS n FROM platform_deleted_repos WHERE id=?', [s.repo.id]))[0].n === 0, { timeoutMs: eraseMs, what: 'the purge' });
      s.purged = ctx.clock.now();
      const done = await waitErased(ctx, s.repo, eraseMs);
      s.erased = ctx.clock.now();
      Object.assign(m, { purge_s_after_due: Math.round((s.purged - due) / 1000), erase_s_after_purge: Math.round((s.erased - s.purged) / 1000), db_bytes_left: done.db_bytes });
    }],
    ['E5', 'Every copy, after: all gone', async (m) => {
      const after = await snapshot(ctx, s.repo);
      m.proof = proofTable({ ...s.before, object: s.object }, after);
      assert.deepEqual(copiesLeft(after), [], 'nothing is left');
      assert.deepEqual(unproven(m.proof), [], 'each copy held something before');
      refused('owner read', await ctx.owner.raw('GET', repoPath(s.repo)), 404, 'GONE');
      refused('anonymous file read', await ctx.anon.raw('GET', s.reads.file), 404, 'GONE', 'NOT_FOUND');
      assert.equal((await ctx.git.clone(s.repo, null)).ok, false, 'a clone is refused');
      assert.ok(!(await ctx.owner.get('/repos/deleted')).repos.some((r) => r.id === s.repo.id), 'off the schedule');
    }],
    ['E6', 'The erase\'s limits, its requests and its cost', async (m) => {
      const events = parseTail(await s.tail.stop());
      const story = eraseStory(events, s.repo.id);
      m.story = story;
      assert.equal(story.shards_cleared, true, 'the log shows all 64 shards and the combiners cleared');
      assert.deepEqual(limitsBroken(story), [], 'the bounds hold');
      m.unseen = unseen;
      const usage = eraseRequests({ keys: s.keys, rows: story.rows, refs: s.refs, prefixes: s.prefixes });
      m.model = { usage, cost: eraseCost(usage) };
      await ctx.clock.sleep(ANALYTICS_LAG_MS);
      m.analytics = await ctx.cf.analytics({ start: s.deleted, end: ctx.clock.now() }, s.repo.object);
      const kills = m.analytics.object_kills_shared;
      if (!kills?.unreadable) assert.equal((kills.exceededCpuErrors ?? 0) + (kills.exceededMemoryErrors ?? 0), 0, 'no object was killed for its limits');
    }],
    ['E7', 'Cache API copies: no way to prove them gone', async (m) => {
      const again = await ctx.anon.raw('GET', s.reads.file);
      m.read = again.status;
      m.colo = (again.headers?.get?.('cf-ray') ?? '').split('-')[1] ?? null;
      assert.equal(again.status, 404, 'a read of a cached file is refused');
      return { skip: 'Reads answer 404, but the Cache API cannot be listed from outside, and a copy is per colo, kept a year. Unproven, by design of this check' };
    }],
  ];
}
