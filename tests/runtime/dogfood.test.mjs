// Kit item 30's pure half (tools/staging/dogfood-plan.mjs): writes to the owner's repository
// are refused outside this run's `dogfood/<ts>-*` branches (main, dev, another run, tricky
// names), the repository lookup is exact, secrets are scrubbed even when added later, steps
// name themselves on failure and soft findings still fail the item, and agents are judged on
// their branch, their diff and their session's place on the change page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentProblems,
  agentTask,
  largestFile,
  leftovers,
  MAX_DOGFOOD_AGENTS,
  olderVersion,
  pickRepo,
  scratch,
  scratchRefs,
  scrubber,
  timedSteps,
} from '../../tools/staging/dogfood-plan.mjs';

const TS = '1761600000000';

test('only this run scratch refs are writable', () => {
  const refs = scratchRefs(TS);
  for (const name of [refs.base, refs.work, refs.change, refs.agent(3), `refs/heads/${refs.behind}`, `refs/tags/${refs.tag}`])
    assert.match(scratch(name, TS), new RegExp(`^dogfood/${TS}-`));
  assert.equal(scratch(`refs/heads/${refs.work}`, TS), refs.work);
  for (const name of ['main', 'refs/heads/main', 'dev', 'refs/heads/dev', `dogfood/${TS}-`, `dogfood/1-work`, `dogfood/${TS}`, `x/dogfood/${TS}-a`, `dogfood/${TS}-a..b`, `dogfood/${TS}-a b`, `dogfood/${TS}-a:main`, `dogfood/${TS}-a@{1}`])
    assert.throws(() => scratch(name, TS), /refusing to write/, name);
  assert.throws(() => scratch(`dogfood/abc-work`, 'abc'), /refusing to write/);
});

test('the repository lookup is exact', () => {
  const repos = [
    { id: 'r104af689e5b24de5a425', name: 'yonedarepo' },
    { id: 'r000000000000000000aa', name: 'yonedarepo-old' },
  ];
  assert.equal(pickRepo(repos, 'yonedarepo').id, 'r104af689e5b24de5a425');
  assert.equal(pickRepo(repos, 'r000000000000000000aa').name, 'yonedarepo-old');
  assert.throws(() => pickRepo(repos, 'yoneda'), /no repository named yoneda/);
  assert.throws(() => pickRepo([...repos, { id: 'r1', name: 'yonedarepo' }], 'yonedarepo'), /2 repositories match/);
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

  const hard = {};
  const ran = [];
  await assert.rejects(
    timedSteps(hard, [['first', () => { throw new Error('boom secret-value-1'); }], ['second', () => ran.push(2)]], scrubber(new Set(['secret-value-1']))),
    /^Error: first: boom \[secret\]$/,
  );
  assert.deepEqual(ran, [], 'a hard failure stops the list');

  const soft = {};
  await assert.rejects(
    timedSteps(soft, [['approve', () => { throw new Error('accepted'); }, { soft: true }], ['after', () => ran.push(3)]]),
    /approve: accepted/,
  );
  assert.deepEqual(ran, [3], 'a soft failure lets the rest run');
  assert.equal(soft.steps.approve, 'FAILED');
});

test('leftovers are this run refs only', () => {
  const refs = {
    'refs/heads/main': 'a',
    'refs/heads/dev': 'b',
    [`refs/heads/dogfood/${TS}-work`]: 'c',
    [`refs/tags/dogfood/${TS}-tag`]: 'd',
    'refs/heads/dogfood/1-work': 'e',
  };
  assert.deepEqual(leftovers(refs, TS), [
    { ref: `refs/heads/dogfood/${TS}-work`, commit: 'c' },
    { ref: `refs/tags/dogfood/${TS}-tag`, commit: 'd' },
  ]);
});

test('the largest Rust file and an older version', () => {
  const tree = [
    '100644 blob aaaa    120\tREADME.md',
    '100644 blob bbbb   9000\tsrc/big.ts',
    '100644 blob cccc   4000\tbackend/a.rs',
    '100644 blob dddd   7000\tbackend/b.rs',
    '040000 tree eeee      -\tbackend',
  ].join('\n');
  assert.deepEqual(largestFile(tree), { path: 'backend/b.rs', bytes: 7000 });
  assert.equal(largestFile('', '.rs'), null);
  assert.equal(olderVersion(1000), 500);
  assert.equal(olderVersion(1), 1);
});

test('agent tasks stay under .dogfood on their own branch', () => {
  const task = agentTask(2, TS);
  assert.equal(task.branch, `dogfood/${TS}-agent-2`);
  assert.equal(task.note, '.dogfood/agent-2.md');
  assert.match(task.text, /git push origin dogfood\/\d+-agent-2$/m);
  assert.match(task.text, /Never push to main or dev, never force-push/);
  assert.throws(() => agentTask(0, TS));
  assert.throws(() => agentTask(MAX_DOGFOOD_AGENTS + 1, TS));
});

test('agents are judged on branch, diff and the session on the change page', () => {
  const task = agentTask(1, TS);
  const session = { id: 7, cli: 'opencode', session_id: 'opencode:abc' };
  const good = { head: 'h', base: 'b', paths: [task.note], sessions: [session], listed: [7] };
  assert.deepEqual(agentProblems(task, good), []);
  assert.match(agentProblems(task, { ...good, head: null })[0], /was not pushed/);
  assert.match(agentProblems(task, { ...good, head: 'b' })[0], /no commit of its own/);
  assert.match(agentProblems(task, { ...good, paths: [task.note, 'README.md'] })[0], /not only \.dogfood\/agent-1\.md/);
  assert.match(agentProblems(task, { ...good, sessions: [{ ...session, cli: 'dogfood' }] })[0], /no opencode session record/);
  assert.match(agentProblems(task, { ...good, listed: [] })[0], /not listed on its change/);
});
