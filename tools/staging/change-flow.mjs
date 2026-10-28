// Item 18 of the staging kit: a change request end to end with the CLI and zero model spend.
// A pushed branch suggests opening a change; `yoneda change create` opens it; a comment is
// anchored to a diff line. The kit account pushed the head, so its own approval is refused
// (also through a repository token it made); the second kit account, added with the land
// role, approves it. `yoneda change land` lands it, and the change reads back landed at the
// head. No webhook receiver is involved.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { secondAccount } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');

/** 18: branch → open change → line comment → approve → land → status landed. `credentials`:
 * the kit account's, from which the second (reviewing) account is derived. */
export async function cliChangeRequest(kit, credentials, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const name = `kit-change-${Date.now()}`;
  const policy = { approvals: 1, required_checks: [] };
  const created = await kit.pat().post('/repos', { name, policy, files: [{ path: 'README.md', content_b64: b64('# change kit\n') }], author });
  const repo = created.id;
  kit.repos.push({ id: repo, name });
  metrics.repo = repo;
  const api = kit.pat();
  const dir = kit.path('change');
  await kit.ok('git', ['clone', '-q', kit.remote(repo), dir]);
  await kit.gitOk(dir, 'checkout', '-q', '-b', 'kit-change');
  mkdirSync(dirname(join(dir, 'src/retry.ts')), { recursive: true });
  writeFileSync(join(dir, 'src/retry.ts'), 'export const tries = 3;\n');
  await kit.gitOk(dir, 'add', '-A');
  await kit.gitOk(dir, 'commit', '-q', '-m', 'Kit: retry three times');

  const pushed = await kit.ok('git', ['push', 'origin', 'kit-change'], { cwd: dir });
  metrics.push_said = pushed.stderr.split('\n').filter((l) => l.startsWith('yoneda:')).join(' | ');
  assert.match(pushed.stderr, /open a change: yoneda change create kit-change/, 'the push did not suggest opening a change');

  const opened = await kit.yonedaOk(['change', 'create'], { cwd: dir });
  const number = Number(opened.stdout.match(/#(\d+) \[open\] Kit: retry three times \(kit-change -> main\)/)?.[1]);
  assert.ok(number > 0, `change create printed no change: ${opened.stdout}`);
  Object.assign(metrics, { change: number, create_ms: opened.ms });
  const path = `/repos/${repo}/changes/${number}`;
  const open = await api.get(path);
  const head = open.head;
  assert.match(String(head), /^[0-9a-f]{40}$/, `the change has no head: ${JSON.stringify(open)}`);
  assert.equal(open.head_commit?.gates?.ready, false, 'an unapproved head is already ready to land');
  assert.deepEqual(
    (await api.get(`${path}?patch=1`)).diff.changes.map((c) => c.path),
    ['src/retry.ts'],
    "the change's diff is not the pushed file",
  );

  const comment = ['change', 'comment', String(number), '-m', 'Why three?', '--path', 'src/retry.ts', '--line', '1', '--side', 'new'];
  await kit.yonedaOk(comment, { cwd: dir });

  // Approval is a review of the head commit by another account than its pusher's: neither
  // the kit account nor a repository token it made may approve it.
  const review = (session) => session.raw('POST', `/repos/${repo}/commits/${head}/reviews`, { decision: 'approve' });
  const own = await api.post(`/repos/${repo}/tokens`, { name: 'kit-own-reviewer', scopes: ['read', 'review'] });
  try {
    for (const [who, session] of [['the pusher', api], ["the pusher's token", kit.pat(own.token)]]) {
      const refused = await review(session);
      const said = `${refused.status} ${refused.body?.error?.message ?? ''}`;
      assert.match(said, /^403 Authors cannot review their own commit/, `${who} was not refused as the author: ${said}`);
    }
  } finally {
    await api.call('DELETE', `/repos/${repo}/tokens/kit-own-reviewer`);
  }
  assert.equal((await api.get(path)).head_commit?.gates?.ready, false, 'a refused review made the head ready');
  const reviewer = await secondAccount(kit.platformAccount.origin.replace(/\/api\/v1$/, ''), credentials);
  await kit.platformAccount.post(`/repos/${repo}/members`, { account: reviewer.name, role: 'land' });
  const approved = await review(reviewer.session);
  assert.ok(approved.ok, `the second account could not approve: ${approved.status} ${approved.body?.error?.message ?? ''}`);
  metrics.reviewer = reviewer.name;
  assert.equal((await api.get(path)).head_commit?.gates?.ready, true, 'the approved head is not ready to land');

  const landed = await kit.yonedaOk(['change', 'land', String(number)], { cwd: dir });
  metrics.land_ms = landed.ms;
  assert.match(landed.stdout, new RegExp(`Landed change #${number} \\(${head}\\) on main`), `change land: ${landed.stdout}`);
  const after = await api.get(path);
  Object.assign(metrics, { status: after.status, landed_version: after.landed_version, head });
  assert.equal(after.status, 'landed', `the change is ${after.status} after landing`);
  assert.equal(after.landed_commit, head, 'the change landed another commit');
  assert.equal(after.comment_count, 1, 'the line comment is missing');
  assert.equal(after.comments[0]?.path, 'src/retry.ts');
  const listed = await api.get(`/repos/${repo}/changes?status=landed`);
  assert.deepEqual(listed.changes.map((c) => c.number), [number]);
}
