// Kit item 30 (`--dogfood`), the product half: a change request on the owner's repository
// (session record, line comment, approval, change page data), its head landed on a scratch
// base, a server-side rebase of a branch behind that base, and the reads a person makes on a
// real codebase (search, blame, history, Overview, a file at an older version, a compare),
// each timed. Changes always target main on the platform, so the change is never landed
// through itself: its head lands on the scratch base and the change is closed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHOR } from './dogfood-git.mjs';
import { largestFile, olderVersion, scratch, scratchRefs, timedSteps } from './dogfood-plan.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
const q = (params) => new URLSearchParams(params).toString();

/** 30.3: open, comment, approve, change page data, land on a scratch base, server-side rebase. */
export async function dogfoodChange(ctx, metrics) {
  const { ws, repo, ts, owner, mint } = ctx;
  const token = await mint('change', ['read', 'write']);
  const refs = scratchRefs(ts);
  const path = `/repos/${repo}`;
  const dir = ws.path('change');
  const git = (...args) => ws.git(dir, token, ...args);
  const headOf = async (branch) => (await owner.get(`${path}/refs`)).refs[`refs/heads/${scratch(branch, ts)}`];
  const pushTo = async (branch) => (await ws.ok('git', ['push', '-q', 'origin', `HEAD:refs/heads/${scratch(branch, ts)}`], { cwd: dir, token })).ms;
  const commitFile = async (file, text, message) => {
    mkdirSync(join(dir, '.dogfood'), { recursive: true });
    writeFileSync(join(dir, file), text);
    await git('add', file);
    await git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const timed = async (key, run) => {
    const started = performance.now();
    const value = await run();
    metrics[key] = Math.round(performance.now() - started);
    return value;
  };
  let head;
  let main;
  await timedSteps(
    metrics,
    [
      ['clone and push change branch', async () => {
        await ws.ok('git', ['clone', '-q', '--filter=blob:none', `${ws.api}/git/${repo}.git`, dir], { token });
        main = await git('rev-parse', 'origin/main');
        await git('switch', '-q', '-c', refs.change, 'origin/main');
        await pushTo(refs.changeBase);
        head = await commitFile('.dogfood/change.md', `dogfood ${ts}: a scratch change\n`, `dogfood ${ts}: scratch change`);
        await pushTo(refs.change);
        assert.equal(await headOf(refs.change), head);
      }],
      ['record a session on the head', async () => {
        await ctx.tokenSession(token).post(`${path}/commits/${head}/sessions`, { cli: 'dogfood', model: 'none', summary: `Dogfood ${ts}: a scratch change on the owner repository.` });
      }],
      ['open the change', async () => {
        const opened = await timed('open_ms', () => owner.post(`${path}/changes`, { branch: scratch(refs.change, ts), title: `Dogfood ${ts}`, body: 'Scratch change from the dogfood kit; closed by it.' }));
        ctx.changes.push(opened.number);
        metrics.change = opened.number;
        metrics.change_base = opened.base;
      }],
      ['line comment', () => timed('comment_ms', () => owner.post(`${path}/changes/${metrics.change}/comments`, { body: 'Dogfood: does this read well?', path: '.dogfood/change.md', line: 1, side: 'new' }))],
      // The owner pushed the head through a repository token they made: an approval by the
      // same person must be refused like any self-review.
      ['self-approval refused', async () => {
        const said = await owner.raw('POST', `${path}/commits/${head}/reviews`, { decision: 'approve' });
        metrics.self_approval = `${said.status} ${said.body?.error?.message ?? 'accepted'}`;
        assert.equal(said.status, 403, `the owner approved their own commit (pushed with their own repository token): ${metrics.self_approval}`);
      }, { soft: true }],
      ['change page data', async () => {
        const change = await timed('change_page_ms', () => owner.get(`${path}/changes/${metrics.change}?patch=1`));
        const paths = (change.diff?.changes ?? []).map((c) => c.path);
        metrics.change_paths = paths.join(',');
        assert.ok(paths.includes('.dogfood/change.md') && paths.every((p) => p.startsWith('.dogfood/')), `the change diff is ${paths.join(', ')}`);
        metrics.gates = JSON.stringify(change.head_commit?.gates ?? null).slice(0, 300);
        metrics.comments = change.comment_count;
        const { sessions } = await timed('change_sessions_ms', () => owner.get(`${path}/sessions?${q({ head, base: main, limit: 200 })}`));
        assert.ok(sessions.some((s) => s.summary?.startsWith(`Dogfood ${ts}`)), 'the recorded session is not on the change page');
      }],
      ['land the head on the scratch base, close the change', async () => {
        const landed = await timed('land_ms', () => owner.post(`${path}/land`, { ref: scratch(refs.changeBase, ts), commit: head }));
        metrics.land_version = landed.version;
        assert.equal(await headOf(refs.changeBase), head, 'the scratch base is not the change head');
        const closed = await owner.post(`${path}/changes/${metrics.change}/close`);
        metrics.change_status = closed.status;
      }],
      ['server-side rebase of a branch behind its base', async () => {
        await git('switch', '-q', '-c', refs.behind, head);
        const behind = await commitFile('.dogfood/behind.md', `behind ${ts}\n`, `dogfood ${ts}: behind`);
        await pushTo(refs.behind);
        const moved = await owner.post(`${path}/commits`, { ref: scratch(refs.changeBase, ts), changes: [{ path: '.dogfood/base-moved.md', content_b64: b64(`base moved ${ts}\n`) }], message: `dogfood ${ts}: base moves`, author: AUTHOR });
        await owner.post(`${path}/land`, { ref: scratch(refs.changeBase, ts), commit: moved.commit });
        const branch = scratch(refs.behind, ts).split('/').map(encodeURIComponent).join('/');
        const rebased = await timed('rebase_ms', () => owner.post(`${path}/branches/${branch}/rebase`, { onto: scratch(refs.changeBase, ts) }));
        assert.equal(rebased.commits?.length, 1, `rebase replayed ${rebased.commits?.length} commit(s)`);
        await ws.ok('git', ['fetch', '-q', 'origin', refs.behind], { cwd: dir, token });
        await git('merge-base', '--is-ancestor', moved.commit, 'FETCH_HEAD');
        assert.notEqual(await git('rev-parse', 'FETCH_HEAD'), behind, 'the branch did not move');
      }],
    ],
    ws.scrub,
  );
}

/** 30.4: reads on the real codebase, each timed (ms) into `metrics.reads`. */
export async function dogfoodReads(ctx, metrics) {
  const { ws, repo, owner } = ctx;
  const path = `/repos/${repo}`;
  metrics.reads = {};
  const read = async (name, url, check) => {
    const started = performance.now();
    const body = await owner.get(`${path}${url}`);
    metrics.reads[name] = Math.round(performance.now() - started);
    check?.(body);
    return body;
  };
  // Sizes only from the full clone: `ls-tree -l` in a blob:none clone fetches every blob.
  const dir = ctx.full ?? ws.path('change');
  const big = ctx.full ? largestFile(await ws.git(dir, null, 'ls-tree', '-r', '-l', 'origin/main')) : null;
  const cli = existsSync(join(ws.bin, 'yoneda')) ? await ctx.mint('reads', ['read']) : null;
  const status = await owner.get(path);
  const at = olderVersion(status.version);
  Object.assign(metrics, { version: status.version, read_at: at, big_rust: big ? `${big.path} (${big.bytes} B)` : 'none' });
  const older = await ws.git(dir, null, 'rev-list', '-n', '1', '--skip', '50', '--first-parent', 'origin/main');
  await timedSteps(
    metrics,
    [
      ['search fn land', () => read('search_fn_land', `/search?${q({ query: 'fn land', ref: 'main' })}`, (b) => assert.ok(b.results?.length > 0, 'no hit for fn land'))],
      ['blame README.md', () => read('blame_readme', `/blame?${q({ path: 'README.md', ref: 'main' })}`)],
      ['blame the largest Rust file', () => (big ? read('blame_big_rust', `/blame?${q({ path: big.path, ref: 'main' })}`) : { skip: 'no Rust file' })],
      ['history (log 100)', () => read('log_100', `/log?${q({ ref: 'main', limit: 100 })}`, (b) => assert.ok((b.commits ?? []).length > 0, 'empty log'))],
      ['path history README.md', () => read('log_readme', `/log?${q({ ref: 'main', path: 'README.md', limit: 50 })}`)],
      ['Overview / code map', () => read('overview', `/views/human?${q({ path: '', ref: 'main' })}`, (b) => assert.ok(b.dependency_map, 'no dependency map'))],
      ['file at an older version (--at)', () => read('blob_at', `/blob?${q({ path: 'README.md', ref: 'main', at: String(at) })}`)],
      ['compare main~50..main', () => read('compare', `/diff?${q({ base: older, head: 'main' })}`, (b) => (metrics.compare_files = b.changes?.length))],
      ['CLI grep and blame --at', async () => {
        if (!cli) return { skip: `no yoneda in ${ws.bin}` };
        const at_ = ['--repo', repo, '--at', String(at)];
        metrics.reads.cli_grep_at = (await ws.ok('yoneda', ['grep', 'fn land', ...at_], { token: cli })).ms;
        metrics.reads.cli_blame_at = (await ws.ok('yoneda', ['blame', 'README.md', ...at_], { token: cli })).ms;
      }],
    ],
    ws.scrub,
  );
}
