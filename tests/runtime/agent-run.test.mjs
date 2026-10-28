// Kit item 29's pure parts (tools/staging/agent-run-plan.mjs): distinct tasks per wave, the
// exact opencode command without secret values, the cost of a run from opencode's JSON
// events, and the verdict on main (lost writes, local merges, unrecorded commits, second-wave
// context).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, MAX_AGENTS, opencodeArgs, printable, prompt, tasks, verdict } from '../../tools/staging/agent-run-plan.mjs';

test('each agent gets its own function, and waves never repeat one', () => {
  const first = tasks(4, 1);
  const second = tasks(2, 2, 4);
  const fns = [...first, ...second].map((t) => t.fn);
  assert.equal(new Set(fns).size, 6);
  assert.deepEqual(first.map((t) => t.agent), ['w1a1', 'w1a2', 'w1a3', 'w1a4']);
  assert.equal(second[0].email, 'kit-agent-w2a1@yonedarepo.invalid');
  assert.throws(() => tasks(MAX_AGENTS, 2, 1));
  assert.throws(() => tasks(0, 1));
  const text = prompt(first[0]);
  assert.match(text, /src\/util\.js/);
  assert.match(text, /- w1a1: added clamp/);
  assert.match(text, /git pull --rebase origin main/);
  assert.match(text, /Never force-push/);
});

test('the opencode command, quoted for the evidence file', () => {
  const args = opencodeArgs({ model: 'zai-coding-plan/glm-5.3', title: 'kit w1a1', text: "add it's" });
  assert.deepEqual(args.slice(0, 7), ['run', '--standalone', '--auto', '--format', 'json', '--model', 'zai-coding-plan/glm-5.3']);
  assert.equal(printable(['opencode', ...args]), "opencode run --standalone --auto --format json --model zai-coding-plan/glm-5.3 --title 'kit w1a1' 'add it'\\''s'");
});

test('a run costs the highest cost each message reported, summed', () => {
  const lines = [
    JSON.stringify({ type: 'message.updated', data: { message: { id: 'm1', type: 'assistant', cost: 0.001 } } }),
    JSON.stringify({ type: 'message.updated', data: { message: { id: 'm1', type: 'assistant', cost: 0.003 } } }),
    JSON.stringify({ type: 'message.updated', data: { message: { id: 'm2', type: 'assistant', cost: 0.002 } } }),
    'not json',
  ];
  assert.ok(Math.abs(costOf(lines) - 0.005) < 1e-12);
  assert.equal(costOf(['{"type":"x"}']), null);
});

test('the verdict finds lost writes, local merges, unrecorded commits and a blind second wave', () => {
  const all = [...tasks(2, 1), ...tasks(1, 2, 2)];
  const util = 'export function clamp(v, a, b) {}\nexport const slugify = (t) => t;\nexport function chunk() {}\n';
  const changelog = '# Changelog\n- w1a1: added clamp\n- w1a2: added slugify\n- w2a1: added chunk\n';
  const commit = (sha, author, parents = ['p'], committer = author) => ({ sha, parents, author, committer });
  const log = [
    commit('c'.repeat(40), all[2].email),
    commit('m'.repeat(40), 'x', ['a', 'b'], 'commits@yonedarepo.invalid'),
    commit('b'.repeat(40), all[1].email),
    commit('a'.repeat(40), all[0].email),
  ];
  const record = [{ cli: 'opencode', session_id: 'opencode:ses_1' }];
  const sessions = { ['a'.repeat(40)]: record, ['b'.repeat(40)]: record, ['c'.repeat(40)]: record };
  const summaries = ['Added clamp(value, min, max) to src/util.js and a CHANGELOG line.'];
  const good = verdict({ tasks: all, util, changelog, log, sessions, contexts: { w2a1: `## Recent sessions\n- 1m ago · opencode · aaaaaaa: Added clamp(value, min, max) to src/util.js and a CHANGELOG line.` }, summaries });
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.metrics, { agent_commits: 3, server_merges: 1, local_merges: 0, recorded: 3 });

  const bad = verdict({
    tasks: all,
    util: util.replace('export const slugify', 'const slugify'),
    changelog: changelog.replace('- w2a1: added chunk\n', ''),
    log: [...log, commit('d'.repeat(40), 'someone', ['x', 'y'], 'someone')],
    sessions: { ['a'.repeat(40)]: record },
    contexts: { w2a1: 'nothing about earlier sessions' },
    summaries,
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, [
    'w1a2: slugify is not on main',
    'w2a1: its CHANGELOG line is not on main',
    'history is not linear: 1 merge commit(s) made in a clone (ddddddd)',
    '2 agent commit(s) without an opencode session record: ccccccc, bbbbbbb',
    'w2a1: its start context names no first-wave session',
  ]);
});
