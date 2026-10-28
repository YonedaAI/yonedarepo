// Item 21 of the staging kit: a server-side rebase with the CLI and zero model spend. Two
// branches are pushed with stock Git; main then moves (a line of the same file, and a file
// one branch also edits). `yoneda rebase` replays the clean branch onto main, and a fresh
// clone shows it linear on main with main's and the branch's edits merged; the conflicting
// branch is refused with its path and stays where it was. The repository is deleted.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');
const NOTES = 'a\nb\nc\nd\ne\n';

/** 21: branch behind main → `yoneda rebase` → linear in a clone; a conflict is refused. */
export async function cliRebase(kit, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const name = `kit-rebase-${Date.now()}`;
  const policy = { approvals: 0, required_checks: [] };
  const files = [
    { path: 'notes.txt', content_b64: b64(NOTES) },
    { path: 'b.txt', content_b64: b64('b\n') },
  ];
  const api = kit.pat();
  const created = await api.post('/repos', { name, policy, files, author });
  const repo = created.id;
  kit.repos.push({ id: repo, name });
  metrics.repo = repo;
  const refs = async () => (await api.get(`/repos/${repo}/refs`)).refs;
  const dir = kit.path('rebase');
  await kit.ok('git', ['clone', '-q', kit.remote(repo), dir]);
  const commit = async (path, text, message) => {
    writeFileSync(join(dir, path), text);
    await kit.gitOk(dir, 'add', '-A');
    await kit.gitOk(dir, 'commit', '-q', '-m', message);
  };
  await kit.gitOk(dir, 'checkout', '-q', '-b', 'kit-topic');
  await commit('notes.txt', NOTES.replace('a\n', 'A\n'), 'Kit: capitalize a');
  await commit('c.txt', 'c\n', 'Kit: add c');
  await kit.gitOk(dir, 'checkout', '-q', '-b', 'kit-clash', 'main');
  await commit('b.txt', 'mine\n', 'Kit: clash on b');
  await kit.ok('git', ['push', '-q', 'origin', 'kit-topic', 'kit-clash'], { cwd: dir });
  const before = await refs();
  const [topic, clash] = [before['refs/heads/kit-topic'], before['refs/heads/kit-clash']];
  assert.match(String(topic), /^[0-9a-f]{40}$/, 'kit-topic was not pushed');

  // Main moves on: notes line 5 merges with the branch; b.txt conflicts with kit-clash.
  const changes = [
    { path: 'notes.txt', content_b64: b64(NOTES.replace('e\n', 'E\n')) },
    { path: 'b.txt', content_b64: b64('theirs\n') },
  ];
  const moved = await api.post(`/repos/${repo}/commits`, { ref: 'main', changes, message: 'Kit: main moves', author });
  assert.equal((await api.post(`/repos/${repo}/land`, { ref: 'main', commit: moved.commit })).landed, true, 'main did not move');
  const main = (await refs())['refs/heads/main'];

  const rebased = await kit.yonedaOk(['rebase', 'kit-topic'], { cwd: dir });
  metrics.rebase_ms = rebased.ms;
  assert.match(rebased.stdout, /Rebased kit-topic onto main: 2 commit\(s\) replayed/, `rebase: ${rebased.stdout}`);
  const head = (await refs())['refs/heads/kit-topic'];
  assert.notEqual(head, topic, 'kit-topic did not move');

  const fresh = kit.path('rebase-clone');
  await kit.ok('git', ['clone', '-q', kit.remote(repo), fresh]);
  const range = 'origin/main..origin/kit-topic';
  assert.equal(await kit.gitOk(fresh, 'rev-parse', 'origin/kit-topic'), head, 'the clone has another kit-topic');
  assert.equal(await kit.gitOk(fresh, 'rev-parse', 'origin/main'), main, 'the clone has another main');
  assert.equal((await kit.git(fresh, 'merge-base', '--is-ancestor', 'origin/main', 'origin/kit-topic')).code, 0, 'kit-topic is not on main');
  assert.equal(await kit.gitOk(fresh, 'rev-list', '--merges', range), '', 'kit-topic has merge commits');
  assert.equal(await kit.gitOk(fresh, 'log', '--format=%s', range), 'Kit: add c\nKit: capitalize a', 'kit-topic is not the two replayed commits');
  assert.equal(await kit.gitOk(fresh, 'show', 'origin/kit-topic:notes.txt'), 'A\nb\nc\nd\nE', 'notes.txt did not merge both edits');
  metrics.linear = true;

  const refused = await kit.yoneda(['rebase', 'kit-clash'], { cwd: dir });
  metrics.conflict_exit = refused.code;
  assert.equal(refused.code, 2, `a conflicting rebase exited ${refused.code}: ${refused.stdout} ${refused.stderr}`);
  assert.match(refused.stderr, /rebase refused, kit-clash unchanged[\s\S]*conflicting: b\.txt/, `conflict: ${refused.stderr}`);
  assert.equal((await refs())['refs/heads/kit-clash'], clash, 'a refused rebase moved kit-clash');

  const done = await kit.yonedaOk(['repo', 'delete', repo, '--confirm', name]);
  kit.repos = kit.repos.filter((r) => r.id !== repo);
  const read = await api.raw('GET', `/repos/${repo}/refs`);
  Object.assign(metrics, { delete_ms: done.ms, read_after: read.status });
  assert.ok([404, 410].includes(read.status), `${repo} still answers ${read.status} after delete`);
}
