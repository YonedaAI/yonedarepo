// The memory test's pure parts (tools/staging/memory-plan.mjs, memory-traps.mjs,
// memory-verdict.mjs, arm-stats.mjs): the schedule and its guarded fork names, opencode's event
// shapes as recorded from real runs, each trap's oracle, the prompt's one difference between
// arms, the scan that keeps a rule hidden, what makes a run invalid, the verdict, and the
// command line's refusals.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { armSummary, compareArms, fisherExact } from '../../tools/staging/arm-stats.mjs';
import { addedLines, ARMS, branchName, DEFAULT_RUNS, deliveryOf, forkName, isTestFork, judgeTrap, memoryEstimate, MIN_RUNS, opencodeUsage, retryableClone, planText, runProblems, schedule } from '../../tools/staging/memory-plan.mjs';
import { deleteFork, scanHidden } from '../../tools/staging/memory-run.mjs';
import { anchoredFiles, armPrompt, seedOrder, TRAPS } from '../../tools/staging/memory-traps.mjs';
import { fillResults, RESULTS_END, RESULTS_START, resultsMarkdown, verdict } from '../../tools/staging/memory-verdict.mjs';

const trap = (id) => TRAPS.find((t) => t.id === id);
const patch = (...lines) => `@@ -1,1 +1,${lines.length} @@\n context\n${lines.map((l) => `+${l}`).join('\n')}\n`;
const judged = (id, changes) => judgeTrap(trap(id), { head: 'b'.repeat(40), base: 'a'.repeat(40), changes }).outcome;

test('summaries refuse claims below 3 samples and compare arms descriptively', () => {
  assert.deepEqual(armSummary([]), { n: 0, mean: null, sd: null, min: null, max: null, note: 'no samples' });
  const two = armSummary([10, 20, Number.NaN]);
  assert.equal(two.n, 2);
  assert.equal(two.note, 'n<3: no claim');
  const three = armSummary([2, 4, 6]);
  assert.deepEqual([three.mean, three.sd, three.min, three.max, three.note], [4, 2, 2, 6, null]);
  assert.match(compareArms([1, 2], [3, 4, 5]).claim, /n<3/);
  assert.match(compareArms([1, 2, 3], [2, 3, 4]).claim, /overlap/);
  const separate = compareArms([9, 10, 11], [19, 20, 21]);
  assert.equal(separate.ratio, 0.5);
  assert.match(separate.claim, /not a significance test/);
});

test('Fisher exact two-sided p matches known tables', () => {
  assert.ok(Math.abs(fisherExact(3, 0, 0, 3) - 0.1) < 1e-9);
  assert.ok(Math.abs(fisherExact(3, 0, 3, 0) - 1) < 1e-9);
  // R: fisher.test(matrix(c(1,9,11,3),2)) p = 0.002759
  assert.ok(Math.abs(fisherExact(1, 9, 11, 3) - 0.002759) < 1e-5);
  // The plan's floor: 5 per arm can reach significance, 3 per arm can't.
  assert.ok(fisherExact(5, 0, 0, 5) < 0.01);
  assert.ok(fisherExact(4, 1, 0, 5) < 0.05);
  assert.ok(fisherExact(3, 0, 0, 3) >= 0.05);
});

test('every arm gets the same traps in blocks, and fewer than 5 runs are refused', () => {
  const blocks = schedule(DEFAULT_RUNS, TRAPS);
  assert.equal(blocks.length, DEFAULT_RUNS);
  assert.deepEqual(blocks.map((b) => b.round), [1, 2, 3, 4, 5, 6]);
  for (const t of TRAPS) assert.equal(blocks.filter((b) => b.trap === t).length, 2);
  assert.ok(DEFAULT_RUNS >= MIN_RUNS);
  assert.throws(() => schedule(4, TRAPS), /at least 5/);
  assert.throws(() => schedule(5.5, TRAPS));
});

test('only forks this test named can be deleted', () => {
  const name = forkName(1793247123965, 'frozen-file', 'memory', 2);
  assert.ok(isTestFork(name));
  assert.equal(branchName('frozen-file', 2), 'memtest/frozen-file-2');
  for (const other of ['oss-cobra', 'oss-commander', 'oss-click', 'claude-code', 'memtest-', 'memtest-1-x-other-1', `${name}-copy`, `x${name}`, '', null]) assert.ok(!isTestFork(other), String(other));
});

test('the estimate names runs, time and quota', () => {
  const e = memoryEstimate({ runs: 6, parallel: 1, timeoutS: 600, traps: 3 });
  assert.deepEqual([e.agents, e.forks, e.typical_minutes, e.worst_minutes, e.tokens], [12, 12, 27, 69, 1_200_000]);
  assert.equal(memoryEstimate({ runs: 6, parallel: 2, timeoutS: 600, traps: 3 }).typical_minutes, 14);
  const text = planText({ runs: 6, parallel: 1, timeoutS: 600, model: 'zai-coding-plan/glm-5.3', traps: TRAPS });
  assert.match(text, /12 real agent runs \(6 per arm\), 12 forks, 3 traps/);
  assert.match(text, /about 27 min, at worst 69 min/);
  assert.match(text, /1\.2 M tokens/);
});

// As recorded from opencode 2.2 in .local/staging/realuser-*/*.events.jsonl.
const session = 'ses_e7a15e176ffepfcNfpBsPC7efW';
const event = (type, part) => JSON.stringify({ type, timestamp: 1793248078178, sessionID: session, part: { sessionID: session, ...part } });
const finish = (id, tokens) => event('step_finish', { id, type: 'step-finish', reason: 'tool-calls', cost: 0, tokens });
const tool = (id, name, state) => event('tool_use', { partID: `prt_${id}`, id, type: 'tool', tool: name, state });
const whole = (path) => tool(`c-${path}`, 'read', { status: 'completed', input: { path }, output: `Read file ${path}, lines 1-40\n1: x` });

test('tokens come from step_finish, once per step, with the cache counted apart', () => {
  const used = opencodeUsage([
    event('step_start', { id: 'prt_0', type: 'step-start' }),
    finish('prt_1', { input: 927, output: 16, reasoning: 17, cache: { read: 4800, write: 0 } }),
    finish('prt_1', { input: 927, output: 16, reasoning: 17, cache: { read: 4800, write: 0 } }),
    finish('prt_2', { input: 100, output: 50, reasoning: 0, cache: { read: 5000, write: 10 } }),
    'not json',
  ]);
  assert.equal(used.session, session);
  assert.equal(used.steps, 2);
  assert.deepEqual(used.tokens, { input: 1027, output: 66, reasoning: 17, cache_read: 9800, cache_write: 10, total: 10920 });
});

test("the read counter counts opencode's lower-case read, and only whole files as whole", () => {
  const used = opencodeUsage([
    whole('/work/a.go'),
    whole('/work/b.go'),
    tool('c3', 'read', { status: 'completed', input: { path: '/work/c.go', offset: 100, limit: 50 }, output: 'Read file /work/c.go, lines 100-150\n100: x' }),
    tool('c4', 'read', { status: 'completed', input: { path: '/work/big.go' }, output: 'Read file /work/big.go, lines 1-2000\n1: x\n[Output truncated. Continue reading with offset: 2001]' }),
    tool('c5', 'read', { status: 'completed', input: { path: '/work' }, output: 'Read directory /work, entries 1-3\na\nb\nc' }),
    tool('c6', 'read', { status: 'error', input: { path: '/work/none' }, error: 'File not found: /work/none' }),
    tool('c7', 'Read', { status: 'completed', input: { path: '/work/d.go' }, output: 'Read file /work/d.go, lines 1-1\n1: x' }),
    tool('c8', 'shell', { status: 'completed', input: { command: 'git status && cat go.mod' }, output: '' }),
    tool('c9', 'shell', { status: 'completed', input: { command: 'cat a.go | head -5' }, output: '' }),
    tool('c10', 'shell', { status: 'completed', input: { command: "cat > new.go <<'EOF'\nx\nEOF" }, output: '' }),
    tool('c11', 'shell', { status: 'completed', input: { command: 'yoneda grep Hidden' }, output: '' }),
    tool('c12', 'shell', { status: 'completed', input: { command: 'yoneda memory list' }, output: '' }),
    tool('c13', 'shell', { status: 'completed', input: { command: 'git log --oneline' }, output: '' }),
    tool('c14', 'edit', { status: 'completed', input: { path: '/work/a.go' }, output: 'Edited' }),
  ]);
  assert.equal(used.whole_file_reads, 4, 'a.go, b.go, d.go and the cat of go.mod');
  assert.equal(used.partial_reads, 2, 'an offset read and a truncated one');
  assert.equal(used.file_reads, 6);
  assert.equal(used.yoneda_calls, 2);
  assert.equal(used.tool_calls, 14);
  assert.equal(used.by_tool.read, 7, 'a directory and a failed read are calls, not file reads');
  assert.ok(used.read_bytes > 0);
  assert.deepEqual(opencodeUsage([]).tokens.total, 0);
});

test('added lines come from the unified patch, without its headers', () => {
  const changes = [{ path: 'a.go', patch: '--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,3 @@\n one\n-two\n+three\n+four\n' }, { path: 'bin', patch: null }];
  assert.deepEqual(addedLines(changes), { 'a.go': ['three', 'four'], bin: [] });
});

test('frozen-file: a new method in command.go falls, one in another file avoids', () => {
  const method = 'func (c *Command) VisibleCommandNames() []string {';
  assert.equal(judged('frozen-file', [{ path: 'command.go', patch: patch(method) }]), 'fell');
  assert.equal(judged('frozen-file', [{ path: 'command_visible.go', patch: patch(method) }]), 'avoided');
  assert.equal(judged('frozen-file', [{ path: 'command_visible.go', patch: patch(method) }, { path: 'command.go', patch: patch('// note') }]), 'fell', 'any line in command.go breaks the rebase');
  assert.equal(judged('frozen-file', [{ path: 'command_test.go', patch: patch(method) }]), 'unfinished', 'a test file does not do the task');
  assert.equal(judged('frozen-file', [{ path: 'README.md', patch: patch('docs') }]), 'unfinished');
});

test('env-prefix: only a CMDR_ name avoids', () => {
  const lib = (...lines) => [{ path: 'lib/help.js', patch: patch(...lines) }];
  assert.equal(judged('env-prefix', lib('if (process.env.COMMANDER_SHOW_HIDDEN) return all;')), 'fell');
  assert.equal(judged('env-prefix', lib('if (process.env.SHOW_HIDDEN) return all;')), 'fell');
  assert.equal(judged('env-prefix', lib('if (process.env.CMDR_SHOW_HIDDEN) return all;')), 'avoided');
  assert.equal(judged('env-prefix', lib("const name = 'CMDR_SHOW_HIDDEN';", 'if (process.env[name]) return all;')), 'avoided');
  assert.equal(judged('env-prefix', lib('if (process.env.CMDR_A || process.env.SHOW_ALL) return all;')), 'fell', 'one other name is still read as undefined');
  assert.equal(judged('env-prefix', lib('const showAll = true;')), 'unfinished');
  assert.equal(judged('env-prefix', [{ path: 'Readme.md', patch: patch('CMDR_SHOW_HIDDEN') }]), 'unfinished', 'a doc does not do the task');
});

test('exit-code: only exit_code 78 avoids', () => {
  const cls = (...lines) => [{ path: 'src/click/exceptions.py', patch: patch('class ConfigFileError(ClickException):', ...lines) }];
  assert.equal(judged('exit-code', cls('    pass')), 'fell');
  assert.equal(judged('exit-code', cls('    exit_code = 1')), 'fell');
  assert.equal(judged('exit-code', cls('    exit_code = 2')), 'fell');
  assert.equal(judged('exit-code', cls('    exit_code = 78')), 'avoided');
  assert.equal(judged('exit-code', cls('    exit_code: t.ClassVar[int] = 78')), 'avoided');
  assert.equal(judged('exit-code', cls('    exit_code = os.EX_CONFIG')), 'avoided');
  assert.equal(judged('exit-code', cls('    exit_code = 780')), 'fell');
  assert.equal(judged('exit-code', [{ path: 'src/click/__init__.py', patch: patch('from .exceptions import X') }]), 'unfinished');
});

test('no push leaves nothing to judge', () => {
  const t = trap('frozen-file');
  assert.equal(judgeTrap(t, { head: null, base: 'a' }).outcome, 'no_push');
  assert.equal(judgeTrap(t, { head: 'a', base: 'a' }).outcome, 'no_push');
});

test('the prompt differs between arms only in the tool paragraph', () => {
  for (const t of TRAPS) {
    const [plain, memory] = ARMS.map((arm) => armPrompt(t, branchName(t.id, 1), arm).split('\n'));
    assert.deepEqual(plain.slice(0, -1), memory.slice(0, -1), t.id);
    assert.notEqual(plain.at(-1), memory.at(-1));
    assert.match(plain.at(-1), /^Tools: /);
    assert.match(memory.at(-1), /^Tools: /);
    assert.equal(plain[0], t.task, 'the task comes first, so the prompt hook reads its words');
  }
  assert.doesNotMatch(armPrompt(TRAPS[0], 'b', 'plain'), /yoneda|memor/i);
  assert.throws(() => armPrompt(TRAPS[0], 'b', 'other'));
});

test('no prompt gives a rule away', () => {
  for (const t of TRAPS)
    for (const arm of ARMS) {
      const text = armPrompt(t, 'memtest/x-1', arm);
      assert.doesNotMatch(text, /CMDR_|exit_code|78|frozen|patch queue|command\.go/, `${t.id} ${arm}`);
    }
});

test('at least 2 traps, each a different rule on its own repository', () => {
  assert.ok(TRAPS.length >= 2);
  assert.equal(new Set(TRAPS.map((t) => t.rule)).size, TRAPS.length);
  assert.equal(new Set(TRAPS.map((t) => t.repo)).size, TRAPS.length);
  for (const t of TRAPS) assert.ok(t.hidden.length > 0, t.id);
});

// context_inject.rs: a delivered line is cut at 360 bytes and an injection at 1536.
const LINE_BYTES = 360;
const PER_INJECTION = 1536;
const START_MEMORIES = 8;

test('the trap memory reaches the agent only by its file or the prompt, behind newer ones', () => {
  for (const t of TRAPS) {
    const seeded = seedOrder(t);
    assert.equal(seeded[0].trap, true, 'the trap is the oldest');
    assert.equal(seeded.length, 13);
    assert.equal(new Set(seeded.map((m) => m.text)).size, 13);
    const start = seeded.slice(-START_MEMORIES);
    assert.ok(!start.some((m) => m.trap || m.near), `${t.id}: the start packet holds only other memories`);
    const onFile = seeded.filter((m) => m.anchors.some((a) => a.path === t.memory.anchors[0].path));
    assert.ok(onFile.filter((m) => !m.trap).length >= 2, `${t.id}: newer memories share its file`);
    for (const m of seeded) {
      assert.ok(Buffer.byteLength(m.text) <= LINE_BYTES, `${t.id}: a line longer than ${LINE_BYTES} is cut, so the rule would be`);
      assert.ok(['decision', 'constraint', 'gotcha', 'howto'].includes(m.kind));
    }
    const lines = onFile.reduce((n, m) => n + Buffer.byteLength(m.text) + 60, 80);
    assert.ok(lines <= PER_INJECTION, `${t.id}: everything on the file fits one injection`);
    assert.ok(anchoredFiles(t).includes(t.memory.anchors[0].path));
  }
});

const memoryItem = (id) => ({ type: 'memory', id, label: 'x' });

test('a delivery is found by memory id, with its trigger and place', () => {
  const list = [
    { trigger: 'start', items: [memoryItem(13), memoryItem(12), { type: 'session', id: 1 }] },
    { trigger: 'read', items: [memoryItem(3), memoryItem(1)] },
  ];
  assert.deepEqual(deliveryOf(list, 1), { delivered: true, trigger: 'read', position: 2, items_before: 4, deliveries: 2 });
  assert.equal(deliveryOf(list, 99).delivered, false);
  assert.equal(deliveryOf([{ trigger: 'read', items: [{ type: 'contract', id: 1 }] }], 1).delivered, false, 'another type with the same id is not it');
  assert.equal(deliveryOf(undefined, 1).delivered, false);
});

test('a run is invalid unless delivery holds in its arm and the agent finished', () => {
  const good = { code: 0, killed: null, session: 's' };
  const delivered = { delivered: true };
  assert.deepEqual(runProblems({ ...good, arm: 'memory', delivery: delivered }), []);
  assert.deepEqual(runProblems({ ...good, arm: 'plain', deliveries: [], memories: 0, yonedaCalls: 0 }), []);
  assert.match(runProblems({ ...good, arm: 'memory', delivery: { delivered: false } })[0], /not delivered/);
  assert.match(runProblems({ ...good, arm: 'plain', deliveries: [{}] })[0], /1 context deliveries/);
  assert.match(runProblems({ ...good, arm: 'plain', memories: 3 })[0], /3 memories/);
  assert.match(runProblems({ ...good, arm: 'plain', yonedaCalls: 1 })[0], /1 yoneda/);
  assert.match(runProblems({ arm: 'plain', code: 1, session: 's' })[0], /exit 1/);
  assert.match(runProblems({ arm: 'plain', code: null, killed: 'time limit 600 s', session: 's' })[0], /time limit/);
  assert.match(runProblems({ arm: 'plain', code: 0 })[0], /no session id/);
});

const record = (trapId, arm, outcome, extra = {}) => ({ trap: trapId, arm, valid: true, oracle: { outcome }, landed: true, tokens: 100, ms: 1000, whole_file_reads: 2, delivery: { delivered: true }, ...extra });
const both = (n, memory, plain, ids = TRAPS.map((t) => t.id)) => Array.from({ length: n }, (_, i) => [record(ids[i % ids.length], 'memory', i < memory ? 'avoided' : 'fell'), record(ids[i % ids.length], 'plain', i < plain ? 'avoided' : 'fell')]).flat();

test('memory helped takes significance and more than one trap', () => {
  const v = verdict(both(6, 6, 0));
  assert.equal(v.answer, 'memory helped');
  assert.ok(Math.abs(v.fisher_p - 0.002165) < 1e-5);
  assert.deepEqual(v.traps.map((t) => [t.memory.yes, t.memory.n, t.plain.yes, t.plain.n]), [[2, 2, 0, 2], [2, 2, 0, 2], [2, 2, 0, 2]]);
  assert.deepEqual(v.too_easy, []);
});

test('one trap alone decides nothing', () => {
  assert.match(verdict(both(6, 6, 0, ['frozen-file'])).answer, /one trap decided it/);
});

test('no difference and a worse result are stated as such', () => {
  assert.match(verdict(both(6, 3, 3)).answer, /no difference shown/);
  assert.equal(verdict(both(6, 0, 6)).answer, 'memory did worse');
  assert.deepEqual(verdict(both(6, 6, 1)).too_easy, [TRAPS[0].id]);
});

test('invalid runs do not count, and too few valid runs give no answer', () => {
  const records = both(6, 6, 0);
  for (const r of records.filter((x) => x.arm === 'memory').slice(0, 2)) Object.assign(r, { valid: false, delivery: { delivered: false } });
  const v = verdict(records);
  assert.match(v.answer, /^no answer: 4 memory and 6 plain/);
  assert.deepEqual(v.invalid, { plain: 0, memory: 2 });
  assert.deepEqual([v.delivered.yes, v.delivered.n], [4, 6]);
  assert.equal(v.avoided.memory.n, 4);
});

test('tokens, time, reads and landing compare the arms', () => {
  const records = both(6, 6, 0).map((r) => (r.arm === 'memory' ? { ...r, tokens: 200, landed: false } : r));
  const v = verdict(records);
  assert.equal(v.tokens.ratio, 2);
  assert.deepEqual([v.landing.memory.yes, v.landing.plain.yes], [0, 6]);
  assert.ok(v.landing.fisher_p < 0.01);
});

test('the results section is filled between its markers and nowhere else', () => {
  const v = verdict(both(6, 6, 0));
  const text = resultsMarkdown(v, { recorded_at: '2026-10-31T12:00:00Z', model: 'zai-coding-plan/glm-5.3', evidence: '.local/staging/memory-test-1.json', commit: 'abc1234' });
  assert.match(text, /\*\*Answer: memory helped\.\*\* Trap avoided: memory 6\/6, plain 0\/6, Fisher p = 0\.0022/);
  assert.match(text, /\| frozen-file \| 2\/2 \| 0\/2 \|/);
  const doc = `before\n${RESULTS_START}\nold\n${RESULTS_END}\nafter\n`;
  const filled = fillResults(doc, 'new');
  assert.equal(filled, `before\n${RESULTS_START}\nnew\n${RESULTS_END}\nafter\n`);
  assert.equal(fillResults(filled, 'again'), `before\n${RESULTS_START}\nagain\n${RESULTS_END}\nafter\n`);
  assert.throws(() => fillResults('no markers', 'new'), /markers/);
});

test('a fork is deleted only under this test\'s own name', async () => {
  const calls = [];
  const owner = { raw: async (method, path) => (calls.push(`${method} ${path}`), { ok: method === 'DELETE', status: method === 'DELETE' ? 200 : 404, body: {} }) };
  await assert.rejects(deleteFork(owner, 'r1', 'oss-cobra'), /refusing to delete oss-cobra/);
  assert.deepEqual(calls, [], 'nothing was sent');
  const name = forkName(1, 'exit-code', 'plain', 1);
  assert.equal(await deleteFork(owner, 'r2', name), 404);
  assert.deepEqual(calls, [`DELETE /repos/r2?confirm=${name}`, 'GET /repos/r2']);
  const refused = { raw: async () => ({ ok: false, status: 409, body: { error: { code: 'CONFLICT' } } }) };
  await assert.rejects(deleteFork(refused, 'r3', name), /409 CONFLICT/);
  const gone = { raw: async () => ({ ok: false, status: 410, body: {} }) };
  assert.equal(await deleteFork(gone, 'r3', name), 410, 'already deleted is fine');
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
const scanCtx = () => ({ scanned: new Map(), ws: { run: async (command, args, { cwd }) => {
  const done = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { code: done.status, stdout: done.stdout.trim(), stderr: done.stderr };
} } });

test('a rule found in the tree, a commit message or old history stops the test', async () => {
  const fixture = (edit) => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-hidden-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'a.js'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'first');
    edit(dir);
    return dir;
  };
  const env = TRAPS.find((t) => t.id === 'env-prefix');
  const code = TRAPS.find((t) => t.id === 'exit-code');
  const dirs = [];
  const scan = (t, edit) => {
    const dir = fixture(edit);
    dirs.push(dir);
    return scanHidden(scanCtx(), t, dir);
  };
  try {
    await scan(env, () => {});
    await assert.rejects(
      scan(env, (dir) => {
        writeFileSync(join(dir, 'a.js'), 'process.env.CMDR_X\n');
        git(dir, 'commit', '-qam', 'second');
      }),
      /reveals its rule/,
      'in the tree',
    );
    await assert.rejects(scan(env, (dir) => git(dir, 'commit', '-q', '--allow-empty', '-m', 'Rename to CMDR_ names')), /reveals its rule/, 'in a message');
    await assert.rejects(
      scan(env, (dir) => {
        writeFileSync(join(dir, 'a.js'), 'cmdr_old\n');
        git(dir, 'commit', '-qam', 'second');
        writeFileSync(join(dir, 'a.js'), 'two\n');
        git(dir, 'commit', '-qam', 'third');
      }),
      /reveals its rule/,
      'only in history',
    );
    await assert.rejects(
      scan(code, (dir) => {
        writeFileSync(join(dir, 'a.js'), 'exit_code: int = 78\n');
        git(dir, 'commit', '-qam', 'second');
      }),
      /reveals its rule/,
      'a value',
    );
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

const kit = (...args) => spawnSync(process.execPath, ['tools/staging-realworld.mjs', ...args], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } });

test('--memory-test prints its estimate and starts nothing without --yes, and refuses --prod', () => {
  const plan = kit('--memory-test');
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /12 real agent runs/);
  assert.match(plan.stdout, /Nothing started/);
  const prod = kit('--memory-test', '--prod', '--yes');
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /--memory-test runs on dev only/);
  assert.match(kit('--memory-page', '--prod').stderr, /--memory-page runs on dev only/);
  const few = kit('--memory-test', '--memory-runs', '4');
  assert.notEqual(few.status, 0);
  assert.match(few.stderr, /at least 5/);
});

test('only a clone the platform answered with 503 is retried', () => {
  assert.equal(retryableClone('error: RPC failed; HTTP 503 curl 22'), true);
  assert.equal(retryableClone('fatal: repository not found'), false);
  assert.equal(retryableClone(undefined), false);
});
