import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { AGENTS_BY_KIND, REPOS } from '../../tools/staging/demo-repos-plan.mjs';

test('retained demos use supported sandbox agents without the removed proxy', () => {
  for (const repo of Object.values(REPOS))
    for (const kind of [repo.agent, ...Object.values(repo.flights).map((f) => f.agent).filter(Boolean)]) {
      assert.ok(['glm', 'codex', 'claude'].includes(kind), `${repo.project}: unsupported ${kind}`);
      assert.ok(AGENTS_BY_KIND[kind]);
    }
});

test('a demo dry run needs no login, Docker, model credential or writes', () => {
  const run = spawnSync(process.execPath, ['tools/staging/demo-repos.mjs', '--dry-run', '--only', 'commander'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.deepEqual(plan.repositories, ['commander']);
  assert.ok(plan.phases.includes('drift'));
  assert.equal(plan.models.codex, 'gpt-5.6-luna');
});
