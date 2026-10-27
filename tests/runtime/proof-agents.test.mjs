import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { proofPlan } from '../../tools/staging/proof-flow.mjs';
import {
  P9_POLICY,
  TOKEN_POLICY,
  armSummary,
  compareArms,
  fisherExact,
  p9Fixture,
  p9Outcome,
  seedCommand,
  seedMismatches,
  stagesFromPlan,
  sumUsage,
  tokenFixture,
  toolProfile,
} from '../../tools/staging/proof-fixtures.mjs';
import { teamVerdict } from '../../tools/staging/sandbox-smoke.mjs';
import { TEAMS } from '../../tools/staging/sandbox-teams.mjs';

function scratch(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** The policy's one check, run as the check sandbox runs it: in the repository root. */
const passes = (policy, dir) => spawnSync(policy.build.checks[0].argv[0], policy.build.checks[0].argv.slice(1), { cwd: dir }).status === 0;

for (const [name, fixture] of [['token', tokenFixture()], ['p9', p9Fixture()]]) {
  test(`the ${name} seed command writes the fixture byte for byte, as argv and through a shell`, () => {
    const { argv, shell } = seedCommand(fixture);
    for (const run of [(cwd) => execFileSync(argv[0], argv.slice(1), { cwd }), (cwd) => execFileSync('/bin/sh', ['-c', shell], { cwd })]) {
      const dir = scratch();
      try {
        run(dir);
        const tree = Object.fromEntries(Object.keys(fixture).map((p) => [p, { content: readFileSync(join(dir, p), 'utf8') }]));
        assert.deepEqual(seedMismatches(fixture, tree), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

test('a seeded tree that differs anywhere is named, so the proof stops before publishing it', () => {
  const fixture = p9Fixture();
  const tree = Object.fromEntries(Object.entries(fixture).map(([p, c]) => [p, { content: c }]));
  tree['src/cart.js'] = { content: `${fixture['src/cart.js']}\n` };
  delete tree['src/format.js'];
  assert.deepEqual(seedMismatches(fixture, tree), ['src/cart.js', 'src/format.js']);
});

test('the p9 check passes the seed and the staged result, and fails a stale call merged with the new signature', () => {
  const pricing = "'use strict';\nfunction price(amount, currency) {\n  if (!currency) throw new Error('currency');\n  return currency === 'usd' ? amount : amount * 2;\n}\nfunction quote(amount) { return price(amount, 'usd'); }\nmodule.exports = { price, quote };\n";
  const checkout = "'use strict';\nconst { price } = require('./pricing.js');\nfunction total(a) { return a.reduce((s, x) => s + price(x, 'usd'), 0); }\nmodule.exports = { total };\n";
  const cart = (call) => `'use strict';\nconst { price } = require('./pricing.js');\nfunction count(items) { return items.length; }\nfunction shipping() { return ${call}; }\nmodule.exports = { count, shipping };\n`;
  const cases = [
    ['seed', {}, true],
    ['shipping alone on the old base', { 'src/cart.js': cart('price(5)') }, true],
    ['file-disjoint merge: stale call', { 'src/pricing.js': pricing, 'src/checkout.js': checkout, 'src/cart.js': cart('price(5)') }, false],
    ['planned: the call follows the new signature', { 'src/pricing.js': pricing, 'src/checkout.js': checkout, 'src/cart.js': cart("price(5, 'usd')") }, true],
    ['pricing without its caller update', { 'src/pricing.js': pricing }, false],
  ];
  for (const [label, change, expected] of cases) {
    const dir = scratch({ ...p9Fixture(), ...change });
    try {
      assert.equal(passes(P9_POLICY, dir), expected, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the token check passes the seed and a right addition, and fails a wrong one', () => {
  const fixture = tokenFixture();
  const add = (body) => fixture['src/billing.js'].replace('module.exports = { ', `function invoiceTotalWithTax(items, rate) {\n  ${body}\n}\n\nmodule.exports = { invoiceTotalWithTax, `);
  for (const [label, change, expected] of [
    ['seed', {}, true],
    ['right', { 'src/billing.js': add('return Math.round(invoiceTotal(items) * (1 + rate) * 100) / 100;') }, true],
    ['wrong', { 'src/billing.js': add('return invoiceTotal(items) + rate;') }, false],
  ]) {
    const dir = scratch({ ...fixture, ...change });
    try {
      assert.equal(passes(TOKEN_POLICY, dir), expected, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('git_plan stages read as task ids; a joined item is refused, not merged into one brief', () => {
  // The shape the platform's work_plan returns for the coupled set (checked natively).
  const coupled = { stages: [[0], [1]], items: [{ members: ['pricing'] }, { members: ['shipping'] }] };
  assert.deepEqual(stagesFromPlan(coupled), [['pricing'], ['shipping']]);
  assert.deepEqual(stagesFromPlan({ stages: [[0, 1]], items: [{ members: ['format'] }, { members: ['shipping'] }] }), [['format', 'shipping']]);
  assert.throws(() => stagesFromPlan({ stages: [[0]], items: [{ members: ['pricing', 'shipping'] }] }), /joined pricing\+shipping/);
});

test('p9 outcomes: rejected is broken, eligible needs every task done, anything else is unsettled', () => {
  const tree = { 'src/pricing.js': { content: 'function quote() {}' }, 'src/cart.js': { content: 'function shipping() {}' } };
  assert.equal(p9Outcome('rejected', tree, ['pricing', 'shipping']), 'broken');
  assert.equal(p9Outcome('eligible', tree, ['pricing', 'shipping']), 'clean');
  assert.equal(p9Outcome('eligible', { 'src/cart.js': tree['src/cart.js'] }, ['pricing', 'shipping']), 'incomplete');
  assert.equal(p9Outcome(null, tree, ['pricing']), 'unsettled');
});

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
});

test('tool profiles count platform reads apart from local reads and searches', () => {
  const entries = [
    { kind: 'init', text: 'Agent started' },
    { kind: 'tool', text: 'Bash export YONEDA_TOKEN=provided-by-worker && yoneda grep invoiceTotal' },
    { kind: 'tool', text: 'Bash yoneda symbols src/billing.js' },
    { kind: 'tool', text: 'Read /workspace/repo/src/billing.js' },
    { kind: 'tool', text: 'Grep invoiceTotal' },
    { kind: 'tool', text: 'Bash rg -n invoice src' },
    { kind: 'tool', text: 'Edit /workspace/repo/src/billing.js' },
  ];
  assert.deepEqual(toolProfile(entries), { tool_calls: 6, yoneda_calls: 2, file_reads: 1, searches: 2 });
});

test('metered usage sums every execution, counting cache reads and writes as input', () => {
  const u = (requests, input, read, write, output, micro) => ({ metered_usage: { requests, input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output, charged_microusd: micro } });
  assert.deepEqual(sumUsage([u(3, 100, 50, 10, 20, 1500), u(1, 10, 0, 0, 5, 500), { metered_usage: null }]), { requests: 4, input: 170, cache_read: 50, output: 25, usd: 0.002 });
});

test('the four-task team verdict counts landings, server merges, conflicts and resumes', () => {
  const landing = (commit, team, resumed = false) => ({ status: 'landed', commit, team_commit: team, resumed });
  const member = (title, l) => ({ sandbox_task: { title }, status: 'landed', landing: l });
  const detail = {
    executions: [
      member('Write src/math.js', landing('a', 'a')),
      member('Write src/strings.js', landing('b', 'm1')),
      member('Title Alpha', landing('c', 'm2')),
      member('Title Beta', landing('d', 'm3', true)),
    ],
  };
  const verdict = teamVerdict(detail, TEAMS.four);
  assert.deepEqual([verdict.landed, verdict.merged, verdict.conflicts, verdict.resumed, verdict.problem], [4, 3, 1, 1, false]);
  detail.executions[3].landing = { status: 'conflict', paths: ['README.md'], round: 1, resumed: true };
  assert.match(teamVerdict(detail, TEAMS.four).problem, /all 4 members landed, found 3/);
  assert.match(teamVerdict({ executions: detail.executions.slice(0, 2) }, TEAMS.four).problem, /expected 4 members, found 2/);
});

test('dry-run plans estimate spend under the cap before anything runs', () => {
  const tokens = proofPlan('tokens', 3);
  assert.equal(tokens.estimate.executions, 7);
  assert.ok(tokens.estimate.usd <= 0.5);
  const p9 = proofPlan('p9', 3);
  assert.equal(p9.estimate.executions, 21);
  assert.ok(p9.estimate.usd <= 0.5);
  assert.deepEqual(Object.keys(p9.plans), ['coupled', 'control']);
  assert.throws(() => proofPlan('p2', 3), /tokens or p9/);
  assert.throws(() => proofPlan('p9', Number.NaN), /--trials is 1 to 10/);
});
