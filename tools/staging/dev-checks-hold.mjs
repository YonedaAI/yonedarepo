// Legal hold, live on dev (dev-checks.mjs), with LEGAL_HOLD=on: a throwaway org's repository held
// by its owner, a tombstone held by an operator, a personal repository, and the whole org. Every
// way to destroy each is tried by whoever could, and refused with nothing lost; lifting the hold
// lets the delete and the erase go on; each action is on the record. Separately, `holdWaitSteps`
// leaves a tombstone held past its due time and lifts the hold with no purge-now, which takes
// the sweep's six hours to come back.
import assert from 'node:assert/strict';
import { auditGaps, copiesLeft, LIMITS, proofTable, shortWindow } from './dev-checks-lib.mjs';
import { author, fileOf, locateObject, newRepo, noteStore, purgeNow, refused, remove, repoPath, snapshot, waitErased, waitFor } from './dev-checks-repos.mjs';

const FILES = [fileOf('a.txt', 'held file\n'), fileOf('README.md', '# Dev check, safe to delete\n')];
/** Past a due time: long enough for two sweeps to find it and the queue to deliver. */
const SWEEPS_MS = 150_000;
const HELD = [423, 'LEGAL_HOLD'];

const held = (what, answer) => refused(what, answer, ...HELD);
const scheduleOf = async (ctx, repo) => (await ctx.cf.d1('SELECT purge_at,sent_at FROM platform_deleted_repos WHERE id=?', [repo.id]))[0] ?? null;

/** Every action a run made, oldest on: `admin_audit` pages back from now to `since`. */
async function operatorAudit(ctx, since) {
  const rows = [];
  for (let before = ''; ; ) {
    const { items, next } = await ctx.operator.get(`/admin/audit${before && `?before=${before}`}`);
    rows.push(...items);
    if (!next || items.at(-1).at < since) return rows;
    before = next;
  }
}

export function holdSteps(ctx) {
  const s = { expected: [], started: ctx.clock.now() };
  const expect = (action, target) => s.expected.push({ action, target });
  const operatorHold = async (repo) => {
    const set = await ctx.operator.post(`/admin/repos/${repo.id}/hold`, {});
    assert.ok(set.hold.operator?.by, 'an operator\'s layer');
    expect('legal_hold.set', repo.id);
  };
  const operatorLift = async (repo) => {
    assert.equal((await ctx.operator.call('DELETE', `/admin/repos/${repo.id}/hold`)).released, true, 'the operator released it');
    expect('legal_hold.release', repo.id);
  };
  const purgeAudited = async (repo) => {
    await purgeNow(ctx, repo);
    expect('repo.purge_now', repo.id);
  };
  const repoHold = (repo) => `/orgs/${s.org}/repos/${repo.id}/hold`;
  return [
    ['H1', 'A throwaway org: a repository with a release, a Landing and a quarantine', async (m) => {
      s.window = shortWindow((await ctx.owner.get('/repos/deleted')).window_days);
      m.window = s.window.label;
      s.org = ctx.ledger.addOrg(`dev_check_${ctx.stamp}`);
      await ctx.owner.post('/orgs', { name: s.org });
      await ctx.owner.post(`/orgs/${s.org}/members`, { account: ctx.memberName, role: 'member' });
      s.repo = await newRepo(ctx, 'hold', { owner: s.org, files: FILES, tokens: [{ name: 'agent', scopes: ['read', 'write', 'land'] }] });
      await noteStore(ctx, s.repo);
      const path = (rest) => repoPath(s.repo, rest);
      const commit = await ctx.owner.post(path('/commits'), { parent: s.repo.commit, changes: [fileOf('b.txt', 'b\n')], message: 'b', author });
      await ctx.owner.post(path('/branches'), { ref: 'side', commit: commit.commit });
      s.change = (await ctx.owner.post(path('/changes'), { title: 'Dev check', branch: 'side' })).number;
      await ctx.owner.post(path(`/changes/${s.change}/close`), {});
      await ctx.owner.post(path('/tags'), { name: 'v1', commit: s.repo.commit });
      await ctx.owner.post(path('/releases'), { tag: 'v1', title: 'one' });
      s.quarantine = (await ctx.owner.post(path('/quarantine'), { path: 'a.txt', reason: 'dev check', retain_days: 30 })).record;
      m.repo = s.repo.id;
    }],
    ['H2', 'The owner holds it; a member can see that and change nothing', async () => {
      const set = await ctx.owner.post(repoHold(s.repo), {});
      assert.ok(set.hold.owner?.by, 'the owners\' layer');
      assert.equal((await ctx.owner.get(repoPath(s.repo, '/hold'))).held, true);
      refused('a member setting a hold', await ctx.member.raw('POST', repoHold(s.repo), {}), 403, 'FORBIDDEN');
      refused('a member lifting it', await ctx.member.raw('DELETE', repoHold(s.repo)), 403, 'FORBIDDEN');
      assert.equal((await ctx.member.get(`/orgs/${s.org}/hold`)).repos[s.repo.id]?.owner?.by, set.hold.owner.by, 'a member sees the hold');
    }],
    ['H3', 'Held: owner and operator are refused, and work goes on', async (m) => {
      const path = (rest = '') => repoPath(s.repo, rest);
      const confirm = ctx.ledger.deletePath(s.repo.id);
      held('owner deletes the repository', await ctx.owner.raw('DELETE', confirm));
      held('owner deletes the release', await ctx.owner.raw('DELETE', path('/releases/v1')));
      held('owner deletes the Landing', await ctx.owner.raw('DELETE', path(`/changes/${s.change}`)));
      held('owner vacuums', await ctx.owner.raw('POST', path('/vacuum'), {}));
      held('owner purges the quarantine', await ctx.owner.raw('POST', path(`/quarantine/${s.quarantine.id}/purge`), { confirm: s.quarantine.target.id }));
      refused('operator purge-now on a live repository', await ctx.operator.raw('POST', `/admin/repos/${s.repo.id}/purge-now`, {}), 409, 'CONFLICT');
      refused('operator purge-orphan', await ctx.operator.raw('POST', `/admin/repos/${s.repo.id}/purge-orphan`, { confirm: s.repo.name }), 409, 'CONFLICT');
      const org = await ctx.owner.raw('DELETE', ctx.ledger.orgPath(s.org));
      assert.ok([409, 423].includes(org.status), `the org delete: ${org.status}`);
      const commit = await ctx.owner.post(path('/commits'), { ref: 'main', changes: [fileOf('c.txt', 'c\n')], message: 'c', author });
      await ctx.owner.post(path('/land'), { ref: 'main', commit: commit.commit });
      assert.equal((await ctx.owner.get(path('/refs'))).refs['refs/heads/main'], commit.commit, 'landing goes on under a hold');
      m.refusals = 5;
    }],
    ['H4', 'Lifted by its owner: deletes work, and the erase runs to its end', async (m) => {
      assert.equal((await ctx.owner.call('DELETE', repoHold(s.repo))).released, true);
      const path = (rest) => repoPath(s.repo, rest);
      assert.equal((await ctx.owner.raw('DELETE', path('/releases/v1'))).status, 200, 'the release goes');
      assert.equal((await ctx.owner.raw('POST', path('/vacuum'), {})).status, 200, 'a vacuum runs');
      await remove(ctx, s.repo);
      await locateObject(ctx, s.repo);
      await purgeAudited(s.repo);
      await waitErased(ctx, s.repo);
      const after = await snapshot(ctx, s.repo);
      assert.deepEqual(copiesLeft(after), [], 'nothing is left');
      m.erased = true;
    }],
    ['H5', 'A tombstone an operator holds: no purge, no erase, by anyone, past its due time', async (m) => {
      s.tomb = await newRepo(ctx, 'hold-tomb', { owner: s.org, files: FILES });
      await noteStore(ctx, s.tomb);
      s.before = await waitFor(ctx, async () => {
        const seen = await snapshot(ctx, s.tomb);
        return seen.r2[`platform/v1/${s.tomb.id}/`].keys > 0 ? seen : null;
      }, { timeoutMs: 120_000, intervalMs: 5000, what: 'its objects in R2' });
      await remove(ctx, s.tomb);
      await operatorHold(s.tomb);
      await locateObject(ctx, s.tomb);
      s.objectBefore = await snapshot(ctx, s.tomb);
      refused('the owner lifting an operator\'s hold', await ctx.owner.raw('DELETE', repoHold(s.tomb)), 403, 'FORBIDDEN');
      held('operator purge-now', await ctx.operator.raw('POST', `/admin/repos/${s.tomb.id}/purge-now`, {}));
      const backfill = await ctx.operator.post('/admin/erase-backfill', { object: s.tomb.object, dry_run: false });
      assert.equal(backfill.state, 'queued', 'the backfill queues, and the job meets the hold');
      expect('repo.erase_backfill', s.tomb.id);
      const { purge_at } = await scheduleOf(ctx, s.tomb);
      const left = purge_at + SWEEPS_MS - ctx.clock.now();
      if (left > 0) await ctx.clock.sleep(left);
      const after = await snapshot(ctx, s.tomb);
      const row = await scheduleOf(ctx, s.tomb);
      assert.ok(row?.sent_at > 0, 'the sweep sent its purge and the schedule keeps it');
      const prefix = `platform/v1/${s.tomb.id}/`;
      assert.equal(after.r2[prefix].keys, s.before.r2[prefix].keys, 'R2 keeps every object');
      assert.equal(after.object.state, 'tombstone', 'the erase has not touched it');
      Object.assign(m, { r2_keys_kept: after.r2[prefix].keys, past_due_s: Math.round((ctx.clock.now() - purge_at) / 1000) });
    }],
    ['H6', 'Lifted by the operator: the erase continues and every copy goes', async (m) => {
      await operatorLift(s.tomb);
      await purgeAudited(s.tomb);
      await waitErased(ctx, s.tomb);
      const after = await snapshot(ctx, s.tomb);
      assert.deepEqual(copiesLeft(after), [], 'nothing is left');
      m.proof = proofTable(s.objectBefore, after);
    }],
    ['H7', 'A personal repository: its owner cannot set a hold, nor delete under one', async () => {
      const solo = await newRepo(ctx, 'hold-solo', { files: FILES });
      refused('a personal owner setting a hold', await ctx.owner.raw('POST', `/orgs/${ctx.ownerName}/hold`, {}), 404, 'NOT_FOUND');
      refused('an owner using the operators\' route', await ctx.owner.raw('POST', `/admin/repos/${solo.id}/hold`, {}), 403, 'FORBIDDEN');
      await operatorHold(solo);
      held('its owner deletes it', await ctx.owner.raw('DELETE', ctx.ledger.deletePath(solo.id)));
      await operatorLift(solo);
      await remove(ctx, solo);
      await purgeAudited(solo);
    }],
    ['H8', 'The whole org: covers what is made later, and each side lifts only its own layer', async () => {
      await ctx.owner.post(`/orgs/${s.org}/hold`, {});
      s.late = await newRepo(ctx, 'hold-late', { owner: s.org, files: FILES });
      held('a repository made after the hold', await ctx.owner.raw('DELETE', ctx.ledger.deletePath(s.late.id)));
      await ctx.operator.post(`/admin/orgs/${s.org}/hold`, {});
      expect('legal_hold.set', s.org);
      assert.equal((await ctx.owner.call('DELETE', `/orgs/${s.org}/hold`)).released, true, 'the owners\' layer goes');
      held('the operator\'s layer stands', await ctx.owner.raw('DELETE', ctx.ledger.deletePath(s.late.id)));
      refused('an owner lifting the operator\'s layer', await ctx.owner.raw('DELETE', `/orgs/${s.org}/hold`), 403, 'FORBIDDEN');
      assert.equal((await ctx.operator.call('DELETE', `/admin/orgs/${s.org}/hold`)).released, true);
      expect('legal_hold.release', s.org);
      await remove(ctx, s.late);
      await purgeAudited(s.late);
    }],
    ['H9', 'Every action is on the record', async (m) => {
      const rows = await operatorAudit(ctx, s.started);
      const gaps = auditGaps(s.expected, rows);
      assert.deepEqual(gaps, [], 'admin_audit has every operator action');
      m.operator_events = s.expected.length;
      if ((await ctx.owner.get(`/orgs/${s.org}`)).audit_log !== true)
        return { skip: `${s.expected.length} operator events found; owners' events go to the org log, and AUDIT_LOG is off on dev, so nobody can read them` };
      const { items } = await ctx.owner.get(`/orgs/${s.org}/audit?limit=200`);
      const layers = items.filter((e) => e.kind.startsWith('legal_hold.')).map((e) => `${e.kind} ${e.details.layer}`);
      for (const event of ['legal_hold.set owner', 'legal_hold.released owner', 'legal_hold.set operator', 'legal_hold.released operator'])
        assert.ok(layers.includes(event), `the org log has ${event}`);
      m.org_events = layers.length;
    }],
  ];
}

/** Lifting a hold with nothing else: the sweep sends again SEND_AGAIN_MS after its last try. */
export function holdWaitSteps(ctx) {
  const s = {};
  return [
    ['W1', 'A tombstone held past its due time, and the hold lifted', async (m) => {
      shortWindow((await ctx.owner.get('/repos/deleted')).window_days);
      s.repo = await newRepo(ctx, 'hold-wait', { files: FILES });
      await noteStore(ctx, s.repo);
      await remove(ctx, s.repo);
      await ctx.operator.post(`/admin/repos/${s.repo.id}/hold`, {});
      await locateObject(ctx, s.repo);
      s.sent = await waitFor(ctx, async () => {
        const row = await scheduleOf(ctx, s.repo);
        return row?.sent_at > 0 ? row.sent_at : null;
      }, { timeoutMs: 900_000, what: 'the sweep trying its purge' });
      await ctx.operator.call('DELETE', `/admin/repos/${s.repo.id}/hold`);
      m.sent_at = s.sent;
    }],
    ['W2', 'The sweep comes back by itself and the erase runs (about six hours)', async (m) => {
      await waitFor(ctx, async () => (await scheduleOf(ctx, s.repo)) === null, { timeoutMs: LIMITS.sendAgainMs + 900_000, intervalMs: 60_000, what: 'the sweep sending the purge again' });
      m.purged_h_after_first_try = Number(((ctx.clock.now() - s.sent) / 3_600_000).toFixed(2));
      await waitErased(ctx, s.repo);
      assert.deepEqual(copiesLeft(await snapshot(ctx, s.repo)), [], 'nothing is left');
    }],
  ];
}
