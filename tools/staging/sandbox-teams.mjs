// The sandbox smoke's owner-written team task lists (sandbox-smoke.mjs `--team`,
// `--team-conflict`, `--team-four`): each task is `[id, title, instructions]`, run by one stock
// CLI in its own sandbox; `paths` must exist on the team branch afterwards and `resumes`, when
// set, is how many members a conflict must have sent back once.
import { SMOKE_BRIEF, SMOKE_POLICY } from './agent-smoke.mjs';

// Each task names the shared interface, since members never talk to each other.
export const TEAMS = {
  disjoint: {
    intent: SMOKE_BRIEF.intent,
    criteria: SMOKE_BRIEF.criteria,
    policy: SMOKE_POLICY,
    paths: ['src/math.js', 'test/math.test.js'],
    tasks: [
      ['math', 'Write src/math.js', 'Create src/math.js in CommonJS: module.exports = { add }, where add(a, b) returns a + b. Another agent writes the test. Create or change no other file.'],
      ['test', 'Write test/math.test.js', "Create test/math.test.js using node:test and node:assert that loads const { add } = require('../src/math.js') and checks add(2, 3) === 5 and add(-1, 1) === 0. Another agent writes src/math.js: do not create it. Create or change no other file."],
    ],
  },
  conflict: {
    intent: 'Retitle the project: the first line of README.md is its title.',
    criteria: ['README.md starts with a level-one heading'],
    policy: {
      version: 'sandbox-team-conflict-v1',
      suite: 'commands-v1',
      environment: SMOKE_POLICY.environment,
      required_checks: ['readme'],
      build: { setup: [], checks: [{ name: 'readme', argv: ['node', '-e', "if(!/^# /.test(require('fs').readFileSync('README.md','utf8')))process.exit(1)"], timeout_seconds: 10 }], static_dir: 'public' },
    },
    paths: ['README.md'],
    tasks: [
      ['alpha', 'Title Alpha', "Replace the first line of README.md with '# Alpha'. Change no other line or file."],
      ['beta', 'Title Beta', "Replace the first line of README.md with '# Beta'. Change no other line or file."],
    ],
    resumes: 1,
  },
  four: {
    intent: 'Four small changes to this repository, one per agent.',
    criteria: ['Every task file exists and the checks pass', 'README.md starts with a level-one heading'],
    policy: {
      version: 'sandbox-team-four-v1',
      suite: 'commands-v1',
      environment: SMOKE_POLICY.environment,
      required_checks: ['math', 'strings', 'readme'],
      build: {
        setup: [],
        checks: [
          SMOKE_POLICY.build.checks[0],
          { name: 'strings', argv: ['node', '-e', "if(require('./src/strings.js').shout('a')!=='A!')process.exit(1)"], timeout_seconds: 10 },
          { name: 'readme', argv: ['node', '-e', "if(!/^# /.test(require('fs').readFileSync('README.md','utf8')))process.exit(1)"], timeout_seconds: 10 },
        ],
        static_dir: 'public',
      },
    },
    paths: ['src/math.js', 'src/strings.js', 'README.md'],
    tasks: [
      ['math', 'Write src/math.js', 'Create src/math.js in CommonJS: module.exports = { add }, where add(a, b) returns a + b. Create or change no other file.'],
      ['strings', 'Write src/strings.js', "Create src/strings.js in CommonJS: module.exports = { shout }, where shout(s) returns s.toUpperCase() + '!'. Create or change no other file."],
      ['alpha', 'Title Alpha', "Replace the first line of README.md with '# Alpha'. Change no other line or file."],
      ['beta', 'Title Beta', "Replace the first line of README.md with '# Beta'. Change no other line or file."],
    ],
    resumes: 1,
  },
};
