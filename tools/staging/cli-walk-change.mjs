// Kit item 48: a change's whole life with a second person reviewing, then tokens, releases and a
// check in a real container. The second person is the kit account, a member of the repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { short } from './cli-walk-kit.mjs';
import { branch, flowRepo } from './cli-walk-land.mjs';
import { OWN_TRAFFIC } from './client.mjs';

const number = (out) => out.change.number;

async function lifeRows(w, me, reviewer, kitName) {
  const repo = await flowRepo(w, me, 'change');
  const change = (n) => me.api.get(`/repos/${repo.id}/changes/${n}`);
  await me.j(['policy', 'set', '{"approvals":1,"required_checks":[]}'], { cwd: repo.dir });
  await w.owner.post(`/repos/${repo.id}/members`, { account: kitName, role: 'land' });
  let head = await branch(me, repo, 'fix', { 'src/retry.rs': 'pub const TRIES: u32 = 3;\n' }, 'Retry three times');
  let n;
  await w.row('change create <branch> --title -m', async () => {
    const out = await me.j(['change', 'create', 'fix', '--title', 'Retry', '-m', 'Why it retries', '--repo', repo.id]);
    n = number(out);
    assert.equal(out.change.head, head);
    const read = await change(n);
    assert.equal(read.title, 'Retry');
    assert.equal(read.body, 'Why it retries');
    assert.equal(read.base, 'main');
  });
  await w.row('change create (the clone\'s branch, its subject) --base', async () => {
    const stage = await branch(me, repo, 'stage', { 'stage.txt': 'stage\n' });
    await branch(me, repo, 'on-stage', { 'on-stage.txt': 'x\n' }, 'Onto stage');
    await me.gitOk(repo.dir, 'checkout', '-q', 'on-stage');
    const out = await me.j(['change', 'create', '--base', 'stage'], { cwd: repo.dir });
    await me.gitOk(repo.dir, 'checkout', '-q', 'main');
    const read = await change(number(out));
    assert.equal(read.title, 'Onto stage', 'the title is not the commit subject');
    assert.equal(read.base, 'stage', `stage is ${stage}`);
    await me.ok(['change', 'close', String(number(out)), '--repo', repo.id]);
  });
  await w.rowOf('change list --status', n, 'change create', async () => {
    const list = async (status) => (await me.j(['change', 'list', ...(status ? ['--status', status] : []), '--repo', repo.id])).changes.map((c) => c.number);
    assert.deepEqual(await list(), [n], 'the default is not the open changes');
    assert.deepEqual(await list('open'), [n]);
    assert.equal((await list('closed')).length, 1, 'the closed change is not listed');
    assert.deepEqual(await list('landed'), []);
    assert.equal((await list('all')).length, 2);
  });
  await w.rowOf('change show', n, 'change create', async () => {
    assert.equal((await me.j(['change', 'show', String(n), '--repo', repo.id])).change?.number ?? n, n);
    const ran = await me.ok(['change', 'show', `#${n}`, '--repo', repo.id]);
    assert.match(ran.stdout, new RegExp(`^#${n} \\[open\\] Retry \\(fix -> main\\)`, 'm'), ran.stdout);
    assert.match(ran.stdout, /not ready: approvals 0\/1/);
    assert.match(ran.stdout, /added src\/retry\.rs|add src\/retry\.rs/, ran.stdout);
    await me.refused(['change', 'show', '999', '--repo', repo.id], 1, /NOT_FOUND|not found/i);
    await me.refused(['change', 'show', '0'], 64, /positive integer/);
  });
  await w.rowOf('change route', n, 'change create', async () => {
    const out = await me.j(['change', 'route', String(n), '--repo', repo.id]);
    assert.ok(JSON.stringify(out).includes(head), `the route lacks the head: ${JSON.stringify(out).slice(0, 300)}`);
    assert.match((await me.ok(['change', 'route', String(n), '--repo', repo.id])).stdout, new RegExp(head.slice(0, 12)));
  });
  await w.rowOf('change comment -m', n, 'change create', async () => {
    await me.j(['change', 'comment', String(n), '-m', 'A plain comment', '--repo', repo.id]);
    assert.equal((await change(n)).comments[0]?.body, 'A plain comment');
  });
  await w.rowOf('change comment --path --line --side', n, 'change create', async () => {
    await me.j(['change', 'comment', String(n), '-m', 'Why three?', '--path', 'src/retry.rs', '--line', '1', '--side', 'new', '--repo', repo.id]);
    const anchored = (await change(n)).comments.find((c) => c.path);
    assert.deepEqual([anchored?.path, anchored?.line, anchored?.side], ['src/retry.rs', 1, 'new']);
    await me.refused(['change', 'comment', '1', '-m', 'x', '--path', 'a', '--line', '2', '--side', 'left'], 64, /--side old\|new/);
  });
  await w.rowOf('change comment --resolve', n, 'change create', async () => {
    await me.j(['change', 'comment', String(n), '--resolve', '--path', 'src/retry.rs', '--line', '1', '--side', 'new', '--repo', repo.id]);
    const anchored = (await change(n)).comments.find((c) => c.path);
    assert.ok(anchored?.resolved_at, 'the thread is still open');
    assert.match((await me.ok(['change', 'show', String(n), '--repo', repo.id])).stdout, /\[resolved\]/);
  });
  await w.rowOf('review reject -m', n && reviewer.token, 'A change and a reviewer', async () => {
    const out = await reviewer.j(['review', 'reject', head, '-m', 'Not yet', '--repo', repo.id]);
    assert.equal(out.decision, 'reject');
    const read = await change(n);
    assert.equal(read.head_commit.gates.rejected, true, 'the head is not rejected');
    assert.match((await me.ok(['change', 'show', String(n), '--repo', repo.id])).stdout, /reject by .*: Not yet/);
    await me.refused(['change', 'land', String(n), '--repo', repo.id], 1, /reject|approval|not ready/i);
  });
  await w.rowOf('review approve (the author is refused)', n && reviewer.token, 'A change and a reviewer', async () => {
    await me.gitOk(repo.dir, 'checkout', '-q', 'fix');
    head = await me.commit(repo.dir, { 'src/retry.rs': 'pub const TRIES: u32 = 2;\n' }, 'Retry twice');
    await me.gitOk(repo.dir, 'push', '-q', 'origin', 'fix');
    await me.gitOk(repo.dir, 'checkout', '-q', 'main');
    await me.refused(['review', 'approve', head, '--repo', repo.id], 1, /Authors cannot review their own commit/);
    const out = await reviewer.j(['review', 'approve', head, '--repo', repo.id]);
    assert.equal(out.decision, 'approve');
    assert.equal((await change(n)).head_commit.gates.ready, true, 'the approved head is not ready');
    assert.match((await me.ok(['change', 'show', String(n), '--repo', repo.id])).stdout, /ready to land/);
    await me.refused(['review', 'maybe', head], 64, /unknown decision/);
  });
  await w.rowOf('change land', n, 'change create', async () => {
    const out = await me.j(['change', 'land', String(n), '--repo', repo.id]);
    const read = await change(n);
    assert.equal(read.status, 'landed');
    assert.equal(read.landed_commit, head);
    assert.equal(await repo.main(), head, 'main is not the head');
    assert.equal(out.head, head);
    assert.deepEqual((await me.j(['change', 'list', '--status', 'landed', '--repo', repo.id])).changes.map((c) => c.number), [n]);
  });
  await w.row('change close, reopen, delete', async () => {
    await me.gitOk(repo.dir, 'pull', '-q', 'origin', 'main');
    await branch(me, repo, 'throwaway', { 'throwaway.txt': 'x\n' });
    const m = number(await me.j(['change', 'create', 'throwaway', '--repo', repo.id]));
    const refs = await repo.refs();
    await me.ok(['change', 'close', String(m), '--repo', repo.id]);
    assert.equal((await change(m)).status, 'closed');
    assert.ok(refs['refs/heads/throwaway'], 'the branch went with the change');
    await me.ok(['change', 'reopen', String(m), '--repo', repo.id]);
    assert.equal((await change(m)).status, 'open');
    await me.refused(['change', 'delete', String(m), '--repo', repo.id], 1, /clos/i);
    await me.ok(['change', 'close', String(m), '--repo', repo.id]);
    await me.ok(['change', 'delete', String(m), '--repo', repo.id]);
    assert.equal((await me.api.raw('GET', `/repos/${repo.id}/changes/${m}`)).status, 404, 'the change is still there');
  });
  return repo;
}

async function tokenRows(w, me, repo) {
  const run = (token) => ({ env: me.env({ YONEDA_TOKEN: token }) });
  let read;
  let limited;
  await w.row('token create --scopes', async () => {
    const made = await me.j(['token', 'create', 'walk-read', '--scopes', 'read', '--repo', repo.id], { raw: true });
    w.secrets.add(made.token);
    read = made.token;
    assert.match(made.token, /^yrp_/);
    assert.equal(made.name, 'walk-read');
    await me.ok(['log', '--repo', repo.id], run(read));
    const copy = me.path('read-token');
    await me.exec('git', ['clone', '-q', `yoneda::${w.api}/${repo.id}`, copy], run(read));
    await me.commit(copy, { 'refused.txt': 'x\n' }, 'Refused');
    const pushed = await me.exec('git', ['push', 'origin', 'main'], { cwd: copy, ...run(read) });
    assert.notEqual(pushed.code, 0, 'a read token pushed');
    assert.match(pushed.stderr, /FORBIDDEN|scope|not allowed|403/i, pushed.stderr);
  });
  await w.row('token create --paths', async () => {
    const made = await me.j(['token', 'create', 'walk-paths', '--scopes', 'read,write', '--paths', 'src/', '--repo', repo.id], { raw: true });
    w.secrets.add(made.token);
    limited = made.token;
    const inside = await me.y(['grep', 'TRIES', '--repo', repo.id], run(limited));
    assert.equal(inside.code, 0, inside.stderr);
    assert.match(inside.stdout, /src\/retry\.rs/);
    const out = await me.y(['grep', 'line', '--repo', repo.id], run(limited));
    assert.ok(!out.stdout.includes('README.md'), 'a path-limited token read outside its paths');
  });
  await w.rowOf('token create --paths: its clone and push', limited, 'The token', async () => {
    const copy = me.path('paths-token');
    const clone = await me.exec('git', ['clone', '-q', `yoneda::${w.api}/${repo.id}`, copy], run(limited));
    assert.equal(clone.code, 0, `a path-limited token cannot clone: ${short(clone.stderr)}`);
  });
  await w.row('token list', async () => {
    const { tokens } = await me.j(['token', 'list', '--repo', repo.id]);
    const names = tokens.map((t) => t.name);
    assert.ok(names.includes('walk-read') && names.includes('walk-paths'), names.join(','));
    assert.ok(!JSON.stringify(tokens).includes('[secret]') && !JSON.stringify(tokens).includes('yrp_'), 'token list prints tokens');
  });
  await w.row('token revoke', async () => {
    await me.j(['token', 'revoke', 'walk-read', '--repo', repo.id]);
    await w.soon(async () => (await me.y(['log', '--repo', repo.id], run(read))).code !== 0, 'the revoked token to stop');
    const after = await me.y(['log', '--repo', repo.id], run(read));
    assert.match(after.stderr, /UNAUTHORIZED|401|revoked|sign/i, after.stderr);
    await me.j(['token', 'revoke', 'walk-paths', '--repo', repo.id]);
    await me.refused(['token', 'revoke', 'nobody', '--repo', repo.id], 1, /NOT_FOUND|not found/i);
  });
}

async function releaseRows(w, me, repo) {
  const asset = me.path('walk-asset.bin');
  const bytes = `asset ${w.ts}\n`;
  writeFileSync(asset, bytes);
  await w.row('release create --title -m --asset', async () => {
    await me.gitOk(repo.dir, 'pull', '-q', 'origin', 'main');
    await me.gitOk(repo.dir, 'tag', '-a', 'v1', '-m', 'Tag message');
    await me.gitOk(repo.dir, 'push', '-q', 'origin', 'v1');
    const out = await me.j(['release', 'create', 'v1', '--title', 'First', '-m', 'Notes here', '--asset', asset], { cwd: repo.dir });
    assert.equal(out.release.title, 'First');
    assert.equal(out.asset.sha256, createHash('sha256').update(bytes).digest('hex'));
    const got = await fetch(`${w.api}/api/v1/repos/${repo.id}/releases/v1/assets/walk-asset.bin`, { headers: { ...OWN_TRAFFIC, authorization: `Bearer ${me.token}` } });
    assert.equal(await got.text(), bytes, 'the asset does not read back');
    assert.equal(got.headers.get('x-yoneda-sha256'), out.asset.sha256);
    await me.refused(['release', 'create', 'no-such-tag', '--repo', repo.id], 1, /tag/i);
  });
  await w.row('release list', async () => {
    assert.deepEqual((await me.j(['release', 'list', '--repo', repo.id])).releases.map((r) => r.tag), ['v1']);
    assert.match((await me.ok(['release', 'list', '--repo', repo.id])).stdout, /^v1 First \(/m);
  });
  await w.row('release show', async () => {
    assert.equal((await me.j(['release', 'show', 'v1', '--repo', repo.id])).release.tag, 'v1');
    const ran = await me.ok(['release', 'show', 'v1', '--repo', repo.id]);
    assert.match(ran.stdout, /Notes here/);
    assert.match(ran.stdout, /walk-asset\.bin \d+ bytes sha256 /);
    assert.match(ran.stdout, /Tag message/, 'the annotated tag is missing');
  });
}

async function checkRows(w, me, repo) {
  const policy = { approvals: 0, required_checks: [], runners: { walk: { command: ['sh', '-c', 'test -f README.md && echo walked-ok'], timeout_seconds: 300 } } };
  let run;
  await w.row('check run <name> --commit', async () => {
    await me.j(['policy', 'set', JSON.stringify(policy), '--repo', repo.id]);
    const head = await repo.main();
    const out = await me.j(['check', 'run', 'walk', '--commit', head, '--repo', repo.id]);
    assert.equal(out.commit, head);
    run = out.run.runs?.[0]?.id ?? out.run.id;
    assert.ok(run, `no run id: ${JSON.stringify(out.run).slice(0, 200)}`);
  });
  await w.rowOf('check status <run-id>', run, 'check run', async () => {
    const done = await w.soonLong(async () => {
      const out = await me.j(['check', 'status', run, '--repo', repo.id]);
      return ['passed', 'failed', 'errored'].includes(out.run.status) && out.run;
    }, 'the check to finish');
    assert.equal(done.status, 'passed', `the check ${done.status}`);
    assert.match((await me.api.get(`/repos/${repo.id}/check-runs/${run}/log`)).log ?? '', /walked-ok/, 'the log lacks the output');
  });
  await w.rowOf('check status --commit', run, 'check run', async () => {
    const out = await me.j(['check', 'status', '--commit', await repo.main(), '--repo', repo.id]);
    assert.ok(JSON.stringify(out.check_runs).includes(run), JSON.stringify(out).slice(0, 300));
  });
  await w.row('check run (default HEAD, in a clone), an unknown name', async () => {
    const ran = await me.y(['check', 'run', 'nobody'], { cwd: repo.dir });
    assert.notEqual(ran.code, 0, 'an unknown check ran');
    assert.ok(ran.stderr.length > 0);
    return ran.stderr.split('\n')[0];
  });
}

export async function changeRowsAll(w, me, reviewer, kitName) {
  const repo = await lifeRows(w, me, reviewer, kitName);
  await tokenRows(w, me, repo);
  await releaseRows(w, me, repo);
  await checkRows(w, me, repo);
  return repo;
}
