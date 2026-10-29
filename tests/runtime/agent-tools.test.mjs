// The pure half of the agent-tools kit item (tools/staging/agent-tools-plan.mjs): which items
// `--agent-tools` and `--realuser` run, the source file and function a contract is recorded
// on, the edit that makes it stale, the bisect branch and its check, the policy change and its
// exact restore, the answers each step asserts, check time, and the browser rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bisectPlan,
  bisectRunner,
  checkSeconds,
  contractListed,
  editedSource,
  missingText,
  pickFunction,
  pinListed,
  realuserItems,
  sourceCandidates,
  withoutRunner,
  withRunner,
} from '../../tools/staging/agent-tools-plan.mjs';

const TS = '1761700000000';

test('--agent-tools runs only the agent tools between sign-in and cleanup; --realuser adds them after reads', () => {
  assert.deepEqual(realuserItems({ 'agent-tools': true }), { everyday: false, tools: true });
  assert.deepEqual(realuserItems({ realuser: true }), { everyday: true, tools: true });
  assert.deepEqual(realuserItems({ dogfood: true, 'agent-tools': true }), { everyday: true, tools: true });
});

test('source candidates are Rust, TypeScript and JavaScript files, never tests, vendored or minified', () => {
  const entries = [
    { name: 'index.js', type: 'blob' },
    { name: 'lib', type: 'tree' },
    { name: 'README.md', type: 'blob' },
    { name: 'app.min.js', type: 'blob' },
    { name: 'thing.test.ts', type: 'blob' },
    { name: 'main.rs', type: 'blob' },
    { name: 'types.d.ts', type: 'blob' },
    { name: 'run.sh', type: 'exec' },
    { name: 'link.ts', type: 'symlink' },
  ];
  assert.deepEqual(sourceCandidates('', entries), ['index.js', 'main.rs']);
  assert.deepEqual(sourceCandidates('src', [{ name: 'a.mjs', type: 'blob' }]), ['src/a.mjs']);
  for (const dir of ['node_modules', 'dist', 'vendor', 'test', 'tests', '__tests__'])
    assert.deepEqual(sourceCandidates(dir, [{ name: 'a.js', type: 'blob' }]), [], dir);
});

test('the function is a real, mid-sized function, never a method stub or a whole module', () => {
  const symbol = (symbol_path, kind, start, end) => ({ symbol_path, kind, start, end });
  const listed = [
    symbol('Cmd', 'class', 0, 4000),
    symbol('tiny', 'function', 0, 20),
    symbol('Cmd::run', 'method', 0, 300),
    symbol('parse', 'function', 100, 700),
    symbol('huge', 'function', 0, 50_000),
  ];
  assert.equal(pickFunction(listed).symbol_path, 'parse');
  assert.equal(pickFunction([symbol('Cmd::run', 'method', 0, 300)]).symbol_path, 'Cmd::run');
  assert.equal(pickFunction([symbol('tiny', 'function', 0, 20)]), undefined);
  assert.equal(pickFunction(undefined), undefined);
});

test('the edit changes the function text but keeps it parseable', () => {
  assert.equal(editedSource('function f(a) {\n  return a;\n}', TS), `function f(a) { /* realuser ${TS} */\n  return a;\n}`);
  assert.equal(editedSource('fn f() -> u8 { 1 }', TS), `fn f() -> u8 { /* realuser ${TS} */ 1 }`);
  // An arrow function without a block keeps its expression; the comment goes after it.
  assert.equal(editedSource('(a) => a + 1', TS), `(a) => a + 1 /* realuser ${TS} */`);
  assert.throws(() => editedSource('', TS), /no source/);
});

test('the bisect branch breaks exactly once, at the named commit, on a scratch path', () => {
  const plan = bisectPlan(TS, 6, 4);
  assert.equal(plan.file, `.realuser/${TS}-bisect.txt`);
  assert.equal(plan.commits.length, 6);
  assert.deepEqual(
    plan.commits.map((c) => c.text.includes('BROKEN')),
    [false, false, false, true, true, true],
  );
  assert.equal(plan.breaking, 3);
  assert.ok(plan.commits.every((c, i) => c.message === `realuser ${TS}: bisect step ${i + 1}`));
  assert.throws(() => bisectPlan(TS, 6, 1), /break after the first/);
  assert.throws(() => bisectPlan(TS, 3, 4), /within/);
  assert.throws(() => bisectPlan('main', 6, 4), /digits/);
});

test('the check is a tiny command: it fails only when the scratch file says BROKEN', () => {
  const plan = bisectPlan(TS, 6, 4);
  const runner = bisectRunner(plan);
  assert.equal(runner.name, `realuser-${TS}-bisect`);
  assert.match(runner.name, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.deepEqual(runner.runner, {
    command: ['sh', '-c', `test ! -f '${plan.file}' || ! grep -q BROKEN '${plan.file}'`],
    timeout_seconds: 60,
  });
});

test('the runner is added without touching the rest of the policy, and the restore is exact', () => {
  const policy = { required_checks: ['unit'], approvals: 1, runners: { unit: { command: ['make'], timeout_seconds: 600 } }, auto_approve: ['docs'] };
  const added = withRunner(policy, 'realuser-1-bisect', { command: ['true'], timeout_seconds: 60 });
  assert.deepEqual(added.required_checks, ['unit']);
  assert.deepEqual(Object.keys(added.runners), ['unit', 'realuser-1-bisect']);
  assert.deepEqual(policy.runners, { unit: { command: ['make'], timeout_seconds: 600 } }, 'the original is not mutated');
  assert.deepEqual(withoutRunner(added, 'realuser-1-bisect'), policy);
  // A policy without runners gets them only for the run, and loses the field again.
  const bare = { required_checks: [], approvals: 0 };
  assert.deepEqual(withoutRunner(withRunner(bare, 'x', { command: ['true'] }), 'x'), bare);
  assert.throws(() => withRunner(added, 'realuser-1-bisect', { command: ['true'] }), /already/);
});

test('a recorded contract is found by its commit, path, symbol and summary', () => {
  const ours = { commit: 'a'.repeat(40), path: 'lib/x.js', symbol_path: 'parse', contract: { summary: `realuser ${TS}: parses` } };
  const records = [{ ...ours, contract: { summary: 'other' } }, { ...ours, seq: 7 }];
  assert.equal(contractListed(records, ours).seq, 7);
  assert.equal(contractListed(records, { ...ours, path: 'lib/y.js' }), undefined);
  assert.equal(contractListed(undefined, ours), undefined);
});

test('a pin is listed with its reason', () => {
  const pins = [{ commit: 'b'.repeat(40), reason: `realuser ${TS} pin` }];
  assert.ok(pinListed(pins, 'b'.repeat(40), `realuser ${TS} pin`));
  assert.ok(!pinListed(pins, 'c'.repeat(40), `realuser ${TS} pin`));
  assert.ok(!pinListed(pins, 'b'.repeat(40), 'other'));
});

test('check time sums the runs of one check, whatever form the result is stored in', () => {
  const detail = (runs) => ({ check_runs: runs });
  const details = [
    detail([{ name: 'realuser-1-bisect', result: JSON.stringify({ duration_ms: 4000 }) }, { name: 'unit', result: { duration_ms: 99_000 } }]),
    detail([{ name: 'realuser-1-bisect', result: { duration_ms: 2500 } }]),
    detail([{ name: 'realuser-1-bisect', result: null }]),
  ];
  assert.deepEqual(checkSeconds(details, 'realuser-1-bisect'), { runs: 3, seconds: 6.5 });
  assert.deepEqual(checkSeconds([], 'x'), { runs: 0, seconds: 0 });
});

test('the browser rows are named by what is missing from the page text', () => {
  const text = `Contracts\nparse lib/x.js\nPins\naaaaaaaaaa realuser ${TS} pin`;
  assert.deepEqual(missingText(text, ['parse', `realuser ${TS} pin`]), []);
  assert.deepEqual(missingText(text, ['parse', 'bbbbbbbbbb']), ['bbbbbbbbbb']);
});

test('the function is found breadth first through tree listings and the first file with one', async () => {
  const { findFunction } = await import('../../tools/staging/realuser-agent-tools.mjs');
  const trees = {
    '': [{ name: 'lib', type: 'tree' }, { name: 'test', type: 'tree' }, { name: 'index.js', type: 'blob' }, { name: '.github', type: 'tree' }],
    lib: [{ name: 'parse.js', type: 'blob' }],
  };
  const symbols = {
    'index.js': [{ symbol_path: 'x', kind: 'function', start: 0, end: 10 }],
    'lib/parse.js': [{ symbol_path: 'parse', kind: 'function', start: 0, end: 400 }],
  };
  const asked = [];
  const rest = {
    get: async (url) => {
      asked.push(url);
      const params = new URLSearchParams(url.split('?')[1]);
      if (url.includes('/tree?')) return { entries: trees[params.get('path')] ?? [] };
      return { symbols: symbols[params.get('path')] ?? [] };
    },
  };
  assert.deepEqual(await findFunction(rest, '/repos/r1'), { path: 'lib/parse.js', symbol_path: 'parse' });
  assert.ok(!asked.some((u) => u.includes('path=test') || u.includes('.github')), 'tests and dot directories are not walked');
  await assert.rejects(findFunction({ get: async () => ({ entries: [], symbols: [] }) }, '/repos/r1'), /no Rust, TypeScript or JavaScript function in 0 source files/);
});

test('a bisect that does not name the breaking commit reports its final record and every check run', async () => {
  const { bisectReport } = await import('../../tools/staging/agent-tools-plan.mjs');
  const commits = ['c1', 'c2', 'c3'].map((c) => c.padEnd(40, '0'));
  const details = [
    { check_runs: [{ id: 'cr_1', name: 'realuser-1-bisect', status: 'passed', result: JSON.stringify({ exit_code: 0, duration_ms: 4100 }) }] },
    { check_runs: [] },
    { check_runs: [{ id: 'cr_3', name: 'realuser-1-bisect', status: 'failed', result: { exit_code: 1, duration_ms: 3900 } }, { id: 'cr_x', name: 'unit', status: 'passed' }] },
  ];
  // The platform once answered a found bisect's result as its stored JSON text.
  const done = { id: 'bi_1', status: 'found', result: '{"first_bad":"c3"}' };
  const report = bisectReport(done, commits, details, 'realuser-1-bisect');
  assert.deepEqual(report.record, done);
  assert.equal(report.first_bad, undefined, 'a result that is not an object names no commit');
  assert.deepEqual(report.runs, [
    { commit: 'c1'.padEnd(40, '0').slice(0, 10), step: 1, status: 'passed', exit_code: 0, duration_ms: 4100 },
    { commit: 'c3'.padEnd(40, '0').slice(0, 10), step: 3, status: 'failed', exit_code: 1, duration_ms: 3900 },
  ]);
  assert.match(report.text, /"status":"found"/);
  assert.match(report.text, /step 3 c300000000 failed exit 1 3\.9 s/);
  const named = bisectReport({ status: 'found', result: { first_bad: commits[2] } }, commits, details, 'realuser-1-bisect');
  assert.equal(named.first_bad, commits[2]);
});
