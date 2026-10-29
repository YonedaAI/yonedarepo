// Kit item 30's pure half (tools/staging/realuser-plan.mjs): writes are refused outside this
// run's `realuser/<ts>-*` branches (main, dev, another run, tricky names), the repository
// lookup is exact, imports take only https URLs or paths and never the yonedarepo codebase,
// secrets are scrubbed even when added later, steps name themselves on failure and soft
// findings still fail the item, reads and agent files are chosen from any repository's own
// files, and agents are judged on their branch, diff, session and landed change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentProblems,
  agentTargets,
  agentTask,
  commonIdentifier,
  DEFAULT_IMPORTS,
  importRefusal,
  leftovers,
  olderVersion,
  parseImports,
  pickRepo,
  protectedMoves,
  readTargets,
  scratch,
  scratchRefs,
  scrubber,
  textFiles,
  timedSteps,
} from '../../tools/staging/realuser-plan.mjs';
import { settledRef } from '../../tools/staging/realuser-git.mjs';

const TS = '1761600000000';

test('only this run scratch refs are writable', () => {
  const refs = scratchRefs(TS);
  for (const name of [refs.base, refs.work, refs.change, refs.agentBase, refs.agent(3), `refs/heads/${refs.behind}`, `refs/tags/${refs.tag}`])
    assert.match(scratch(name, TS), new RegExp(`^realuser/${TS}-`));
  assert.equal(scratch(`refs/heads/${refs.work}`, TS), refs.work);
  for (const name of ['main', 'refs/heads/main', 'dev', 'refs/heads/dev', `realuser/${TS}-`, 'realuser/1-work', `realuser/${TS}`, `x/realuser/${TS}-a`, `realuser/${TS}-a..b`, `realuser/${TS}-a b`, `realuser/${TS}-a:main`, `realuser/${TS}-a@{1}`, `dogfood/${TS}-work`])
    assert.throws(() => scratch(name, TS), /refusing to write/, name);
  assert.throws(() => scratch('realuser/abc-work', 'abc'), /refusing to write/);
});

test('the repository lookup is exact', () => {
  const repos = [
    { id: 'rcc448e04fc429bc481e0', name: 'claude-code' },
    { id: 'r000000000000000000aa', name: 'claude-code-old' },
  ];
  assert.equal(pickRepo(repos, 'claude-code').id, 'rcc448e04fc429bc481e0');
  assert.equal(pickRepo(repos, 'r000000000000000000aa').name, 'claude-code-old');
  assert.throws(() => pickRepo(repos, 'claude'), /no repository named claude/);
  assert.throws(() => pickRepo([...repos, { id: 'r1', name: 'claude-code' }], 'claude-code'), /2 repositories match/);
});

test('imports take https URLs and paths, never the yonedarepo codebase', () => {
  assert.deepEqual(parseImports(['oss-x=https://github.com/a/x.git', 'local=../some/repo', 'abs=/tmp/repo']), [
    { name: 'oss-x', source: 'https://github.com/a/x.git' },
    { name: 'local', source: '../some/repo' },
    { name: 'abs', source: '/tmp/repo' },
  ]);
  for (const bad of ['https://github.com/a/x.git', '=x', 'bad name=x', 'x=git@github.com:a/x.git', 'x=http://h/x.git', 'x=ssh://h/x', 'x='])
    assert.throws(() => parseImports([bad]), /--import/, bad);
  assert.equal(importRefusal({ source: 'https://github.com/YonedaAI/yonedarepo.git', sourceTop: null, root: '/k' }), 'the yonedarepo codebase is never test data');
  assert.match(importRefusal({ source: '../yonedarepo-dogfood', sourceTop: '/x/yonedarepo-dogfood', root: '/k' }), /never test data/);
  assert.match(importRefusal({ source: '.', sourceTop: '/k', root: '/k' }), /own checkout/);
  assert.equal(importRefusal({ source: 'https://github.com/spf13/cobra.git', sourceTop: null, root: '/k' }), null);
  assert.ok(DEFAULT_IMPORTS.length >= 3 && DEFAULT_IMPORTS.every((d) => parseImports([`${d.name}=${d.source}`]).length === 1 && !importRefusal({ source: d.source, root: '/k' })));
});

test('secrets are scrubbed, including ones added later', () => {
  const secrets = new Set(['hunter2-password']);
  const scrub = scrubber(secrets);
  secrets.add('yrp_minted_later_123');
  assert.equal(scrub('pw hunter2-password tok yrp_minted_later_123 short'), 'pw [secret] tok [secret] short');
  secrets.add('abc');
  assert.equal(scrub('abc'), 'abc', 'values under 8 characters are not secrets worth hiding');
});

test('steps are timed, name their failure and keep soft findings', async () => {
  const metrics = {};
  await timedSteps(metrics, [['one', async () => {}], ['skipped', () => ({ skip: 'why' })]]);
  assert.equal(typeof metrics.steps.one, 'number');
  assert.equal(metrics.steps.skipped, 'skipped: why');
  const ran = [];
  await assert.rejects(
    timedSteps({}, [['first', () => { throw new Error('boom secret-value-1'); }], ['second', () => ran.push(2)]], scrubber(new Set(['secret-value-1']))),
    /^Error: first: boom \[secret\]$/,
  );
  assert.deepEqual(ran, [], 'a hard failure stops the list');
  const soft = {};
  await assert.rejects(timedSteps(soft, [['approve', () => { throw new Error('refused'); }, { soft: true }], ['after', () => ran.push(3)]]), /approve: refused/);
  assert.deepEqual(ran, [3], 'a soft failure lets the rest run');
  assert.equal(soft.steps.approve, 'FAILED');
});

test('leftovers are this run refs only', () => {
  const refs = { 'refs/heads/main': 'a', [`refs/heads/realuser/${TS}-work`]: 'c', [`refs/tags/realuser/${TS}-tag`]: 'd', 'refs/heads/realuser/1-work': 'e' };
  assert.deepEqual(leftovers(refs, TS), [
    { ref: `refs/heads/realuser/${TS}-work`, commit: 'c' },
    { ref: `refs/tags/realuser/${TS}-tag`, commit: 'd' },
  ]);
});

const TREE = [
  '100644 blob a1   2400\tREADME.md',
  '100644 blob a2  90000\tpackage-lock.json',
  '100644 blob a3   5200\tdocs/guide.md',
  '100644 blob a4  31000\tlib/command.js',
  '100644 blob a5  12000\tlib/option.js',
  '100644 blob a6 2000000\tdata/huge.json',
  '100644 blob a7   9000\tvendor/x.go',
  '100644 blob a8    100\tCHANGELOG.md',
  '100644 blob a9   4000\t.github/workflows/ci.yml',
  '100644 blob b1  50000\tassets/logo.png',
  '040000 tree b2      -\tlib',
].join('\n');

test('reads come from the repository itself, in any language', () => {
  assert.deepEqual(textFiles(TREE).map((f) => f.path), ['README.md', 'docs/guide.md', 'lib/command.js', 'lib/option.js', 'data/huge.json', 'CHANGELOG.md', '.github/workflows/ci.yml']);
  assert.deepEqual(readTargets(TREE), { readme: 'README.md', largest: { path: 'lib/command.js', bytes: 31000 } });
  assert.equal(readTargets('100644 blob c 900\tsrc/main.go').readme, 'src/main.go', 'no README: the largest text file');
  assert.deepEqual(readTargets(''), { readme: null, largest: null });
  const source = 'const program = new Command();\nprogram.option("x");\nprogram.parse();\nfunction parseOptions(argv) { return program.opts(argv); }\nreturn this;';
  assert.equal(commonIdentifier(source), 'program');
  assert.equal(commonIdentifier('if a then b'), null);
  assert.equal(olderVersion(1000), 500);
  assert.equal(olderVersion(1), 1);
});

test('agents get distinct real files: docs first, then source; never hidden or huge', () => {
  assert.deepEqual(agentTargets(TREE, 3), ['README.md', 'lib/command.js', 'docs/guide.md']);
  assert.deepEqual(agentTargets(TREE, 9), ['README.md', 'lib/command.js', 'docs/guide.md', 'lib/option.js']);
  const doc = agentTask({ n: 1, ts: TS, repo: 'oss-commander', target: 'README.md' });
  assert.equal(doc.branch, `realuser/${TS}-agent-1`);
  assert.equal(doc.kind, 'doc');
  assert.match(doc.text, /fix one typo or make one unclear sentence clearer/);
  assert.match(doc.text, /Change only README\.md/);
  assert.match(doc.text, /git push origin realuser\/\d+-agent-1$/m);
  assert.match(doc.text, /Never push to main or any other branch, never force-push/);
  const code = agentTask({ n: 2, ts: TS, repo: 'oss-commander', target: 'lib/command.js' });
  assert.equal(code.kind, 'comment');
  assert.match(code.text, /add one short comment .* Change no code\./);
  assert.notEqual(doc.agent, agentTask({ n: 1, ts: TS, repo: 'oss-cobra', target: 'README.md' }).agent, 'agents are named per repository');
  assert.throws(() => agentTask({ n: 0, ts: TS, repo: 'r', target: 'a.md' }));
  assert.throws(() => agentTask({ n: 1, ts: TS, repo: 'r', target: undefined }), /no file for agent 1/);
});

test('agents are judged on branch, diff, session on the change and the landed change', () => {
  const task = agentTask({ n: 1, ts: TS, repo: 'oss-cobra', target: 'README.md' });
  const session = { id: 7, cli: 'opencode', session_id: 'opencode:abc', model: 'zai-coding-plan/glm-5.3' };
  const good = { head: 'h', base: 'b', paths: ['README.md'], sessions: [session], listed: [7], status: 'landed' };
  assert.deepEqual(agentProblems(task, good), []);
  assert.match(agentProblems(task, { ...good, head: null })[0], /was not pushed/);
  assert.match(agentProblems(task, { ...good, head: 'b' })[0], /no commit of its own/);
  assert.match(agentProblems(task, { ...good, paths: ['README.md', 'go.mod'] })[0], /not only README\.md/);
  assert.match(agentProblems(task, { ...good, sessions: [{ ...session, cli: 'realuser' }] })[0], /no opencode session record/);
  assert.match(agentProblems(task, { ...good, listed: [] })[0], /not listed on its change/);
  assert.match(agentProblems(task, { ...good, status: 'open' })[0], /is open, not landed/);
  assert.match(agentProblems(task, { ...good, status: undefined })[0], /not opened/);
});

test('protected refs: a missing dev is unchanged, an outside move warns, a move by this run fails', () => {
  const refs = ['refs/heads/main', 'refs/heads/dev'];
  const was = { 'refs/heads/main': 'a', 'refs/heads/dev': null };
  const same = protectedMoves({ repo: 'r1', refs, was, now: { 'refs/heads/main': 'a' }, ts: TS });
  assert.deepEqual(same, { problems: [], warnings: [] });
  const owner = [{ refname: 'refs/heads/main', actor: 'user:owner', new: 'b' }];
  const outside = protectedMoves({ repo: 'r1', refs, was, now: { 'refs/heads/main': 'b' }, entries: owner, ts: TS });
  assert.deepEqual(outside.problems, []);
  assert.match(outside.warnings[0], /r1 refs\/heads\/main moved during the run: a -> b by user:owner, not this run/);
  const ours = [{ refname: 'refs/heads/main', actor: `token:realuser-${TS}-git`, new: 'b' }];
  assert.match(protectedMoves({ repo: 'r1', refs, was, now: { 'refs/heads/main': 'b' }, entries: ours, ts: TS }).problems[0], /by this run/);
  assert.match(protectedMoves({ repo: 'r1', refs, was, now: { 'refs/heads/main': 'b' }, entries: [], ts: TS }).problems[0], /no log entry/);
});

test('a ref just moved is polled within the refs snapshot bound', async () => {
  let reads = 0;
  const owner = { get: async () => ({ refs: ++reads < 3 ? {} : { 'refs/heads/x': 'c' } }) };
  const seen = {};
  assert.equal(await settledRef(owner, 'r1', 'refs/heads/x', 'c', seen), 'c');
  assert.equal(reads, 3);
  assert.ok(seen.lag_ms >= 150, `lag ${seen.lag_ms}`);
  const never = { get: async () => ({ refs: {} }) };
  const started = Date.now();
  assert.equal(await settledRef(never, 'r1', 'refs/heads/x', 'c'), undefined);
  assert.ok(Date.now() - started >= 2500, 'gave up before the bound');
});

test('cleanup deletes scratch branches at their current heads, read as of the current version', async () => {
  const { deleteScratch } = await import('../../tools/staging/realuser-flow.mjs');
  const branch = `refs/heads/realuser/${TS}-work`;
  const calls = [];
  let heads = { 'refs/heads/main': 'm', [branch]: 'old' };
  const fake = (batch) => ({
    get: async (path) => {
      calls.push(path);
      return path.endsWith('/r1') ? { version: 42 } : { refs: heads };
    },
    raw: async (method, path, body) => {
      calls.push(`${method} ${path} ${JSON.stringify(body.updates)}`);
      return batch(body);
    },
  });
  // A head that moved between read and delete is read again and deleted at its new value.
  let tries = 0;
  const moving = fake(() => (++tries === 1 ? ((heads = { ...heads, [branch]: 'new' }), { ok: false, status: 409, body: { error: { code: 'STALE_HEAD', message: 'Stale expected heads' } } }) : { ok: true }));
  assert.equal(await deleteScratch(moving, 'r1', TS), 1);
  assert.ok(calls.includes('/repos/r1/refs?min_version=42'), calls.join('\n'));
  assert.match(calls.at(-1), /"expected":"new"/);
  assert.ok(!calls.some((c) => c.includes('refs/heads/main"')), 'main is never in a delete');
  // Any other refusal is reported with the platform's reason.
  heads = { [branch]: 'x' };
  const refused = fake(() => ({ ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'no' } } }));
  await assert.rejects(deleteScratch(refused, 'r1', TS), /refs\/batch refused: 403 FORBIDDEN no/);
  heads = {};
  assert.equal(await deleteScratch(refused, 'r1', TS), 0);
});

test("an agent's session must name the real model it ran on", () => {
  const task = agentTask({ n: 1, ts: TS, repo: 'oss-cobra', target: 'README.md' });
  const good = { head: 'h', base: 'b', paths: ['README.md'], listed: [7], status: 'landed' };
  const session = (model) => ({ id: 7, cli: 'opencode', session_id: 'opencode:abc', model });
  assert.deepEqual(agentProblems(task, { ...good, sessions: [session('zai-coding-plan/glm-5.3')] }), []);
  for (const model of [null, undefined, 'none', ''])
    assert.match(agentProblems(task, { ...good, sessions: [session(model)] })[0], /names no model/, String(model));
});
