// Kit item 30 (`--realuser`), the product half: a change request on a test repository based
// on a scratch branch (session record, line comment, approval, change page data), landed
// through the change on that base, a server-side rebase of a branch behind the base, and the
// reads a person makes on a real codebase of any language (search for a common identifier,
// blame the README and the largest text file, history, Overview, a file at an older version
// and commit, a compare), each timed. main is never a change's base here.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHOR, settledRef } from './realuser-git.mjs';
import { commonIdentifier, olderVersion, readTargets, scratch, scratchRefs, timedSteps } from './realuser-plan.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
const q = (params) => new URLSearchParams(params).toString();

/** 30.3: open, comment, approve, change page data, land on a scratch base, server-side rebase. */
export async function realuserChange(ctx, metrics) {
  const { ws, repo, ts, owner, mint } = ctx;
  const token = await mint('change', ['read', 'write']);
  const refs = scratchRefs(ts);
  const path = `/repos/${repo}`;
  const dir = ws.path('change');
  const git = (...args) => ws.git(dir, token, ...args);
  const headOf = (branch, expected) => settledRef(owner, repo, `refs/heads/${scratch(branch, ts)}`, expected, metrics);
  const pushTo = async (branch) => (await ws.ok('git', ['push', '-q', 'origin', `HEAD:refs/heads/${scratch(branch, ts)}`], { cwd: dir, token })).ms;
  const commitFile = async (file, text, message) => {
    mkdirSync(join(dir, '.realuser'), { recursive: true });
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
        head = await commitFile('.realuser/change.md', `realuser ${ts}: a scratch change\n`, `realuser ${ts}: scratch change`);
        await pushTo(refs.change);
        assert.equal(await headOf(refs.change, head), head);
      }],
      ['record a session on the head', async () => {
        await ctx.tokenSession(token).post(`${path}/commits/${head}/sessions`, { cli: 'realuser', summary: `Real-user ${ts}: a scratch change on the owner repository.` });
      }],
      ['open the change', async () => {
        const base = scratch(refs.changeBase, ts);
        const opened = await timed('open_ms', () => owner.post(`${path}/changes`, { branch: scratch(refs.change, ts), base, title: `Real-user ${ts}`, body: 'Scratch change from the realuser kit, landed on its scratch base.' }));
        ctx.changes.push({ repo, number: opened.number });
        metrics.change = opened.number;
        metrics.change_base = opened.base;
        assert.equal(opened.base, base, 'the change was not opened on its scratch base');
      }],
      ['line comment', () => timed('comment_ms', () => owner.post(`${path}/changes/${metrics.change}/comments`, { body: 'Real-user: does this read well?', path: '.realuser/change.md', line: 1, side: 'new' }))],
      // The head was pushed by a repository token the owner minted, so it is that token's
      // work and the owner may approve it (deliberate: agents push with tokens the owner
      // mints and the human approves them; reviewers.rs). Only the owner's own pushes, by
      // session or personal token, are refused to the owner.
      ['owner approves the token-pushed head', async () => {
        const said = await owner.raw('POST', `${path}/commits/${head}/reviews`, { decision: 'approve' });
        metrics.token_head_approval = `${said.status} ${said.body?.error?.message ?? 'accepted'}`;
        assert.equal(said.status, 200, `the owner could not approve a commit pushed by their repository token: ${metrics.token_head_approval}`);
      }, { soft: true }],
      ['change page data', async () => {
        const change = await timed('change_page_ms', () => owner.get(`${path}/changes/${metrics.change}?patch=1`));
        const paths = (change.diff?.changes ?? []).map((c) => c.path);
        metrics.change_paths = paths.join(',');
        assert.ok(paths.includes('.realuser/change.md') && paths.every((p) => p.startsWith('.realuser/')), `the change diff is ${paths.join(', ')}`);
        metrics.gates = JSON.stringify(change.head_commit?.gates ?? null).slice(0, 300);
        metrics.comments = change.comment_count;
        assert.equal(change.base_protected, false, 'the scratch base reads as protected');
        const { sessions } = await timed('change_sessions_ms', () => owner.get(`${path}/sessions?${q({ head, base: main, limit: 200 })}`));
        assert.ok(sessions.some((s) => s.summary?.startsWith(`Real-user ${ts}`)), 'the recorded session is not on the change page');
      }],
      ['land the change on its scratch base', async () => {
        const change = await owner.get(`${path}/changes/${metrics.change}`);
        const landed = await timed('land_ms', () => owner.post(`${path}/land`, { ref: scratch(change.base, ts), commit: change.head }));
        metrics.land_version = landed.version;
        assert.equal(await headOf(refs.changeBase, head), head, 'the scratch base is not the change head');
        const after = await owner.get(`${path}/changes/${metrics.change}`);
        metrics.change_status = after.status;
        assert.deepEqual([after.status, after.landed_commit], ['landed', head], 'landing the head on its base did not land the change');
      }],
      ['server-side rebase of a branch behind its base', async () => {
        await git('switch', '-q', '-c', refs.behind, head);
        const behind = await commitFile('.realuser/behind.md', `behind ${ts}\n`, `realuser ${ts}: behind`);
        await pushTo(refs.behind);
        const moved = await owner.post(`${path}/commits`, { ref: scratch(refs.changeBase, ts), changes: [{ path: '.realuser/base-moved.md', content_b64: b64(`base moved ${ts}\n`) }], message: `realuser ${ts}: base moves`, author: AUTHOR });
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

/** 30.4: reads a person makes on the repository, each timed (ms) into `metrics.reads`. What
 * to blame and search for comes from the repository itself (any language). */
export async function realuserReads(ctx, metrics) {
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
  if (!ctx.full) return { skip: 'no full clone (30.1) to choose what to read' };
  const dir = ctx.full;
  const { readme, largest } = readTargets(await ws.git(dir, null, 'ls-tree', '-r', '-l', 'origin/main'));
  if (!readme || !largest) return { skip: 'no text files on main' };
  const term = commonIdentifier(await ws.git(dir, null, 'show', `origin/main:${largest.path}`));
  const cli = existsSync(join(ws.bin, 'yoneda')) ? await ctx.mint('reads', ['read']) : null;
  const status = await owner.get(path);
  // An imported repository has no main before its import's version: read at or after it.
  const first = (await owner.get(`${path}/txlog?${q({ after: 0, limit: 50 })}`)).entries?.find((e) => e.refname === 'refs/heads/main')?.version ?? 1;
  const at = Math.max(first, olderVersion(status.version));
  const commits = Number(await ws.git(dir, null, 'rev-list', '--count', '--first-parent', 'origin/main'));
  const older = await ws.git(dir, null, 'rev-list', '-n', '1', '--skip', String(Math.min(50, commits - 1)), '--first-parent', 'origin/main');
  Object.assign(metrics, { version: status.version, read_at: at, readme, largest: `${largest.path} (${largest.bytes} B)`, search_term: term });
  await timedSteps(
    metrics,
    [
      ['search a common identifier', () => (term ? read('search', `/search?${q({ query: term, ref: 'main' })}`, (b) => assert.ok(b.results?.length > 0, `no hit for ${term}`)) : { skip: 'no identifier' })],
      ['blame the README', () => read('blame_readme', `/blame?${q({ path: readme, ref: 'main' })}`)],
      ['blame the largest text file', () => read('blame_largest', `/blame?${q({ path: largest.path, ref: 'main' })}`)],
      ['history (log 100)', () => read('log_100', `/log?${q({ ref: 'main', limit: 100 })}`, (b) => assert.ok((b.commits ?? []).length > 0, 'empty log'))],
      ['path history of the README', () => read('log_readme', `/log?${q({ ref: 'main', path: readme, limit: 50 })}`)],
      ['Overview / code map', () => read('overview', `/views/human?${q({ path: '', ref: 'main' })}`, (b) => assert.ok(b.dependency_map, 'no dependency map'))],
      ['file at an older version (--at)', () => read('blob_at', `/blob?${q({ path: readme, ref: 'main', at: String(at) })}`)],
      ['file at an older commit', () => read('blob_commit', `/blob?${q({ path: readme, commit: older })}`)],
      ['compare an older commit..main', () => read('compare', `/diff?${q({ base: older, head: 'main' })}`, (b) => (metrics.compare_files = b.changes?.length))],
      ['CLI grep and blame --at', async () => {
        if (!cli) return { skip: `no yoneda in ${ws.bin}` };
        const at_ = ['--repo', repo, '--at', String(at)];
        if (term) metrics.reads.cli_grep_at = (await ws.ok('yoneda', ['grep', term, ...at_], { token: cli })).ms;
        metrics.reads.cli_blame_at = (await ws.ok('yoneda', ['blame', readme, ...at_], { token: cli })).ms;
      }],
    ],
    ws.scrub,
  );
}
