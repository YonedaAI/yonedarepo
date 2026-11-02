// What the enterprise checks share (dev-checks.mjs): making a repository this run owns, looking at
// every copy of it, waiting on a clock a test can replace, and leaving nothing behind. `ctx` holds
// the sessions, the Cloudflare reads, Git and the clock, so tests/runtime/dev-checks.test.mjs runs
// the flows against a stand-in. Nothing here deletes what `ctx.ledger` did not record.
import assert from 'node:assert/strict';
import { b64 } from './client.mjs';
import { D1_ROWS, NAME_PREFIX, r2Prefixes, refusal } from './dev-checks-lib.mjs';

export const OPEN = { required_checks: [], approvals: 0 };
export const author = { name: 'Dev checks', email: 'dev-checks@yonedarepo.invalid' };
export const fileOf = (path, text) => ({ path, content_b64: b64(text) });
export const repoPath = (repo, rest = '') => `/repos/${repo.id}${rest}`;

/** `probe`'s first truthy answer, on `ctx.clock`. */
export async function waitFor(ctx, probe, { timeoutMs, intervalMs = 15_000, what }) {
  const deadline = ctx.clock.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    assert.ok(ctx.clock.now() < deadline, `Timed out waiting for ${what}`);
    await ctx.clock.sleep(intervalMs);
  }
}

/** A new repository of `owner` (the kit account by default), with `name` when it must be that. */
export async function newRepo(ctx, label, { owner, visibility = 'private', files = [], tokens = [], name } = {}) {
  const chosen = name ?? `${NAME_PREFIX}${label}-${ctx.stamp}`;
  const body = { name: chosen, owner, visibility, policy: OPEN, ...(files.length && { files, author }), ...(tokens.length && { tokens }) };
  const created = await ctx.owner.post('/repos', body);
  const token = created.tokens?.[0]?.token;
  ctx.secrets.add(token);
  return ctx.ledger.add({ id: created.id, name: chosen, commit: created.commit, org: owner ?? null, token });
}

/** The store of `repo`, known only while it lives. */
export async function noteStore(ctx, repo) {
  repo.store = (await ctx.owner.get(repoPath(repo))).object_store;
  return repo.store;
}

/** A repository object's state, asked without changing it (`erased` needs no name). */
export const objectState = (ctx, object) => ctx.operator.post('/admin/erase-backfill', { object, dry_run: true });

/**
 * Finds `repo`'s object id. Only Cloudflare knows ids, and only a tombstone's store names its
 * repository, so this runs between a delete and the erase: every id new since the run began is
 * asked once, each one a read of a live repository at most.
 */
export async function locateObject(ctx, repo, { timeoutMs = 180_000 } = {}) {
  repo.object = await waitFor(
    ctx,
    async () => {
      for (const id of await ctx.cf.objects()) {
        if (ctx.knownObjects.has(id)) continue;
        const answer = await objectState(ctx, id);
        if (answer.repo === repo.id) return id;
        // Live may be ours, not deleted yet; so may another tombstone of this run.
        const ours = ctx.ledger.repos.some((r) => r.id === answer.repo);
        if (answer.state !== 'live' && !ours) ctx.knownObjects.add(id);
      }
      return null;
    },
    { timeoutMs, intervalMs: 10_000, what: `the object of ${repo.id}` },
  );
  ctx.knownObjects.add(repo.object);
  return repo.object;
}

/** Every copy of `repo` Cloudflare can show. A failed probe throws: it never reads as gone. */
export async function snapshot(ctx, repo) {
  const d1 = {};
  for (const [table, column] of D1_ROWS) {
    const [row] = await ctx.cf.d1(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`, [repo.id]);
    d1[table] = row.n;
  }
  const r2 = {};
  for (const prefix of r2Prefixes(repo.id, repo.store)) r2[prefix] = await ctx.cf.r2(prefix);
  return {
    d1,
    r2,
    object: repo.object ? await objectState(ctx, repo.object) : null,
  };
}

/** Asserts `answer` refused, with status `status` and (when given) one of `codes`. */
export function refused(what, answer, status, ...codes) {
  const [got, code] = refusal(answer);
  assert.equal(got, status, `${what}: answered ${got} ${code ?? ''}`);
  if (codes.length) assert.ok(codes.includes(code), `${what}: answered ${got} ${code}`);
}

/** Deletes a repository of this run. */
export async function remove(ctx, repo) {
  const answer = await ctx.owner.raw('DELETE', ctx.ledger.deletePath(repo.id));
  assert.equal(answer.status, 200, `delete: ${refusal(answer)}`);
  assert.deepEqual(answer.body, { deleted: true });
  repo.deleted = true;
  repo.deleted_at = ctx.clock.now();
}

/** Waits for the object to say `erased`. */
export async function waitErased(ctx, repo, timeoutMs = 600_000) {
  const done = await waitFor(ctx, async () => {
    const answer = await objectState(ctx, repo.object);
    return answer.state === 'erased' ? answer : null;
  }, { timeoutMs, what: `the erase of ${repo.id}` });
  repo.erased = true;
  return done;
}

/** Deletes and purges at once what a step left: the kit's teardown, for the next run's sake. */
export async function purgeNow(ctx, repo) {
  const answer = await ctx.operator.raw('POST', `/admin/repos/${repo.id}/purge-now`, {});
  assert.equal(answer.status, 200, `purge-now: ${refusal(answer)}`);
}

/** Runs `steps` of `[id, title, work]` in order: once one fails, the rest have nothing to stand
 * on and say so. */
export async function runSteps(recorder, steps) {
  let failed = null;
  for (const [id, title, work] of steps) {
    if (failed) {
      await recorder.step(id, title, () => ({ skip: `after ${failed} failed` }));
      continue;
    }
    const item = await recorder.step(id, title, work);
    if (item.status === 'fail') failed = id;
  }
  return !failed;
}

const quietly = (work) => work().catch(() => null);

/**
 * Whatever a run leaves: holds lifted, repositories deleted and purged, orgs deleted. Never
 * throws. Answers what is still there, which the run reports.
 */
export async function cleanUp(ctx) {
  const left = [];
  for (const org of ctx.ledger.orgs) {
    await quietly(() => ctx.owner.raw('DELETE', `/orgs/${org}/hold`));
    await quietly(() => ctx.operator.raw('DELETE', `/admin/orgs/${org}/hold`));
  }
  for (const repo of ctx.ledger.repos.filter((r) => !r.erased)) {
    await quietly(() => ctx.operator.raw('DELETE', `/admin/repos/${repo.id}/hold`));
    if (repo.org) await quietly(() => ctx.owner.raw('DELETE', `/orgs/${repo.org}/repos/${repo.id}/hold`));
    if (!repo.deleted) await quietly(() => ctx.owner.raw('DELETE', ctx.ledger.deletePath(repo.id)));
    const purged = await quietly(() => ctx.operator.raw('POST', `/admin/repos/${repo.id}/purge-now`, {}));
    if (!purged?.ok) left.push(repo.id);
  }
  // An org refuses to go while a repository is listed, and a repository leaves the list at once.
  for (const org of ctx.ledger.orgs) {
    const gone = await quietly(() => ctx.owner.raw('DELETE', ctx.ledger.orgPath(org)));
    if (!gone?.ok) left.push(org);
  }
  return left;
}
