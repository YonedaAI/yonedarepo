// Item 44's fork case: a reader's fork proposes a Landing on a repository whose rules a check alone
// would satisfy. The check passing is not enough: CTC holds for an approval of the head, a newer
// push from the fork voids an approval of the older one, and the approved head lands by itself.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitRepo, settled } from './feature-kit.mjs';
import { change, CI, decisionOn, landedOf, passCheck, QUEUE_MS, reasonCodes, staysOpen } from './flight-kit.mjs';
import { gitConfigEnv } from '../own-traffic.mjs';

const RULES = { approvals: 0, required_checks: [CI] };

/** The fork's own work: its token in Git's environment, never an argument. */
const forkGit = (kit, token) => {
  const env = kit.env({ ...gitConfigEnv({ token, origin: kit.api }) });
  return (dir, ...args) => kit.ok('git', args, { cwd: dir, env });
};

async function commitAndPush(kit, git, dir, text, message) {
  writeFileSync(join(dir, 'forked.txt'), text);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', message);
  await git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/kit-fork');
  return kit.gitOk(dir, 'rev-parse', 'HEAD');
}

/** F4: `reviewer` is the second account: the forker here, since a reader can fork. */
export async function flightFork(kit, { reviewer: member }) {
  const api = kit.pat();
  const repo = await kitRepo(kit, 'kit-fail-fork', { policy: RULES });
  await api.call('PUT', repo.path('/auto-landings'), { land_when_cleared: true });
  await api.post(repo.path('/members'), { account: member.name, role: 'read' });
  const ci = kit.pat((await api.post(repo.path('/tokens'), { name: 'kit-ci', scopes: ['read', `check:${CI}`] })).token);
  const fork = await member.session.post(repo.path('/fork'), { name: `${repo.name}-fork` });
  let pat = null;
  try {
    pat = await member.session.post('/tokens', { name: `kit-fail-${Date.now()}`, scopes: ['repo:read', 'repo:write'], repos: [repo.id, fork.id], expires_days: 1 });
    const git = forkGit(kit, pat.token);
    const dir = kit.path('fail-fork');
    await git(kit.path(), 'clone', '-q', `${kit.api}/git/${fork.id}.git`, dir);
    const first = await commitAndPush(kit, git, dir, 'one\n', 'From a fork');
    const { number } = await member.session.post(repo.path('/changes'), { fork: fork.id, branch: 'kit-fork', title: 'From a fork' });

    await passCheck(ci, repo, first);
    const held = await decisionOn(kit, repo, number, first, 'FORK_NEEDS_APPROVAL');
    assert.equal(held.decision, 'hold', JSON.stringify(held));
    assert.equal((await api.get(repo.path(`/changes/${number}/gates`))).ready, true, 'the rules alone are met: only the fork rule holds it');
    await staysOpen(kit, repo, number, 'a stranger\'s commit landed on a passing check');

    await api.post(repo.path(`/commits/${first}/reviews`), { decision: 'approve' });
    const racedPast = await settled(async () => {
      const read = await change(kit, repo, number);
      return read.status === 'landed' && read;
    }, 'the approved head to land', QUEUE_MS).catch(() => null);
    assert.ok(racedPast, 'an approved fork head did not land by itself');
    assert.equal(racedPast.landed_commit, first, 'it landed another head');
    assert.ok(racedPast.clearances[0].state.approved_by.length === 1, `who approved it: ${JSON.stringify(racedPast.clearances[0].state)}`);

    const next = await commitAndPush(kit, git, dir, 'two\n', 'From a fork again');
    const opened = await member.session.post(repo.path('/changes'), { fork: fork.id, branch: 'kit-fork', title: 'From a fork again' });
    await passCheck(ci, repo, next);
    await decisionOn(kit, repo, opened.number, next, 'FORK_NEEDS_APPROVAL');
    await api.post(repo.path(`/commits/${next}/reviews`), { decision: 'approve' });
    const landed = await landedOf(kit, repo, opened.number);
    return `check alone held ${reasonCodes(held)}; approved heads landed, v${racedPast.landed_version} and v${landed.landed_version}`;
  } finally {
    if (pat) await member.session.raw('DELETE', `/tokens/${pat.id}`);
    await member.session.raw('DELETE', `/repos/${fork.id}?confirm=${encodeURIComponent(`${repo.name}-fork`)}`);
  }
}
