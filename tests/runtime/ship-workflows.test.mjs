// Pins the rules of the workflows on a public repository (docs/ship-pipeline.md). GitHub is the
// only real test of a workflow; these catch the mistakes that would leak or deploy by accident.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const files = readdirSync(WORKFLOWS);
const actions = ['env-file', 'node', 'setup'].map((name) => readFileSync(join(ROOT, `.github/actions/${name}/action.yml`), 'utf8'));
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** `{ id: text }` of a workflow's jobs. */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const parts = body.split(/^ {2}(?=[a-z][a-z-]*:$)/m).slice(1);
  return Object.fromEntries(parts.map((part) => [part.slice(0, part.indexOf(':')), code(part)]));
}
const SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository && github.head_ref == 'dev'";

test('every action is pinned by commit', () => {
  for (const text of [...files.map(read), ...actions])
    for (const [, action] of code(text).matchAll(/^\s*(?:- )?uses: (\S+)/gm)) if (!action.startsWith('./')) assert.match(action, /@[0-9a-f]{40}$/, action);
});

test('no workflow runs on pull_request_target or workflow_run', () => {
  for (const name of files) assert.doesNotMatch(code(read(name)), /pull_request_target|workflow_run/, name);
});

test('secrets reach only jobs with an Environment, and only one secret', () => {
  for (const name of files)
    for (const [id, job] of Object.entries(jobs(read(name))))
      if (/secrets\./.test(job)) {
        assert.match(job, /^ {4}environment: (dev|production)$/m, `${name} ${id}`);
        assert.deepEqual(new Set([...job.matchAll(/secrets\.(\w+)/g)].map(([, s]) => s)), new Set(['YONEDA_ENV_FILE']), `${name} ${id}`);
      }
});

test('the ship is CI only: Check and Full, from this repository, no secrets, no deploy, no kit', () => {
  const text = read('ship.yml');
  const ship = jobs(text);
  assert.deepEqual(Object.keys(ship), ['gate', 'check', 'full']);
  assert.ok(ship.gate.includes(`if: ${SAME_REPO}`));
  assert.match(ship.check, /needs: gate\n\s+uses: \.\/\.github\/workflows\/ci\.yml\n\s+with:\n\s+ship: true/);
  assert.match(ship.full, /needs: gate\n\s+uses: \.\/\.github\/workflows\/full\.yml\n\s+with:\n\s+ship: true/);
  assert.doesNotMatch(code(text), /secrets|environment:|xtask deploy|staging-realworld|upload-artifact/);
});

test('no kit runs on GitHub and no evidence leaves the Mac', () => {
  for (const name of files) {
    assert.doesNotMatch(code(read(name)), /staging-realworld/, name);
    if (name !== 'full.yml') assert.doesNotMatch(code(read(name)), /upload-artifact|download-artifact|gh run download/, name);
  }
});

test('deploy output reaches the log only through quiet.mjs', () => {
  for (const name of ['deploy-prod.yml', 'deploy-dev.yml']) {
    const text = code(read(name));
    assert.doesNotMatch(text, /\btee\b|GITHUB_STEP_SUMMARY|set -x/, name);
    for (const line of text.split('\n'))
      if (/cargo xtask (deploy|downloads|infra)/.test(line)) assert.match(line, /node tools\/ship\/quiet\.mjs (deploy|smoke) -- /, line);
  }
});

test('the secret scan keeps findings out of the public log and fails closed', () => {
  const text = code(read('ci.yml'));
  assert.match(text, /fetch-depth: 0/);
  assert.match(text, /cargo xtask health secrets --base "\$BASE"/);
  assert.doesNotMatch(text, /gitleaks-action/);
  // gitleaks prints authors and emails with these; only our own report line reaches the log.
  for (const name of files) assert.doesNotMatch(code(read(name)), /gitleaks (git|dir|detect|protect)|--verbose/, name);
  assert.match(text, /sha256sum -c -/);
});

test('Check runs every health gate, in step with `cargo xtask check`', () => {
  const text = code(read('ci.yml'));
  const arm = readFileSync(join(ROOT, 'xtask/src/commands.rs'), 'utf8');
  for (const gate of ['lines', 'migrations', 'secrets', 'size']) {
    assert.match(text, new RegExp(`cargo xtask health ${gate}`), gate);
    assert.match(arm, new RegExp(`health::check_${gate}`), gate);
  }
  // Before its use: the xtask tests plant a fake secret, and the Wasm must exist for the budget.
  assert.ok(text.indexOf('Install gitleaks') < text.indexOf('cargo test -p xtask --bins'));
  assert.ok(text.indexOf('worker-build --release') < text.indexOf('cargo xtask health size'));
  assert.ok(text.indexOf('pnpm --dir frontend build') < text.indexOf('cargo xtask health size'));
});

test('the nightly is one job with no secrets, no artifacts and no deploy, on this repository', () => {
  const text = read('nightly.yml');
  const nightly = jobs(text);
  assert.deepEqual(Object.keys(nightly), ['differential']);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  assert.match(text, /^ {4}- cron: '\d+ \d+ \* \* \*'$/m);
  assert.match(nightly.differential, /if: github\.repository == 'YonedaAI\/yonedarepo'/);
  assert.match(nightly.differential, /timeout-minutes: \d+/);
  assert.match(nightly.differential, /YONEDA_DIFF_SEED_START: \$\{\{ github\.run_number \}\}00/);
  assert.match(nightly.differential, /--lib differential -- --ignored/);
  assert.doesNotMatch(code(text), /secrets|environment:|xtask deploy/);
});

test('Check and Full are reusable and keep their manual runs, in a group of their own', () => {
  for (const name of ['ci.yml', 'full.yml']) {
    const text = read(name);
    assert.match(text, /^ {2}workflow_call:$/m, name);
    assert.match(text, /^ {2}workflow_dispatch:$/m, name);
    assert.match(text, /group: \w+-\$\{\{ inputs\.ship && 'ship' \|\| /, name);
  }
});

test('prod deploys on push to main in ship mode, keeps a manual re-run and the owner gate', () => {
  const text = read('deploy-prod.yml');
  assert.match(text, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(text, /^ {2}workflow_dispatch:$/m);
  const job = jobs(text);
  assert.match(job.gate, /github\.actor != 'MagnetonIO'/);
  assert.match(job.gate, /github\.ref != 'refs\/heads\/main'/);
  assert.match(job.deploy, /needs\.gate\.outputs\.ship == 'true'/);
  assert.match(job.deploy, /flags=\(--confirm --ship-head "\$PR_HEAD"\)/);
  assert.match(job.deploy, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(job.deploy, /statuses: read/);
  for (const id of ['deploy', 'downloads', 'smoke', 'monitor']) assert.match(job[id], /^ {4}environment: production$/m, id);
  assert.match(job.smoke, /cargo xtask infra smoke --env prod/);
  assert.doesNotMatch(job.smoke, /playwright|cloudflared/);
  assert.match(job.monitor, /tools\/ship\/monitor\.mjs/);
  assert.match(job.downloads, /cli_needed == 'true'/);
});

test('the steps that run wrangler without a token file export it for that step alone', () => {
  const job = jobs(read('deploy-prod.yml'));
  for (const id of ['deploy', 'downloads']) assert.match(job[id], /CLOUDFLARE_API_TOKEN=\$\(sed -n .*deploy-prod\.env\)\n\s+export CLOUDFLARE_API_TOKEN/, id);
  assert.doesNotMatch(read('deploy-prod.yml'), /GITHUB_ENV/);
});

test('the ship lookup gets the token it reads', () => {
  const source = readFileSync(join(ROOT, 'tools/ship/find-ship.mjs'), 'utf8');
  assert.match(source, /GH_TOKEN: token/);
  assert.match(jobs(read('deploy-prod.yml')).gate, /GH_TOKEN: \$\{\{ github\.token \}\}\n\s+run: node tools\/ship\/find-ship\.mjs/);
});

test('--allow-active is never the default, and nothing rolls back on its own', () => {
  const text = read('deploy-prod.yml');
  assert.match(text, /allow_active:\n(.*\n){2}\s+default: false/);
  assert.match(text, /if \[ "\$ALLOW_ACTIVE" = "true" \]; then flags\+=\(--allow-active\); fi/);
  for (const name of files) {
    assert.doesNotMatch(code(read(name)).replace(/.*ALLOW_ACTIVE.*/g, ''), /--allow-active/, name);
    assert.doesNotMatch(code(read(name)), /xtask rollback|wrangler rollback/, name);
  }
});

test('the env file is written 0600 outside the tree, masked by value', () => {
  const [envFile] = actions;
  assert.match(envFile, /umask 077/);
  assert.match(envFile, /\$HOME\/\.config\/yonedarepo/);
  assert.match(envFile, /::add-mask::\$value/);
  assert.match(envFile, /YONEDA_ENV_FILE is not set/);
  for (const name of ['deploy-prod.yml', 'deploy-dev.yml']) assert.match(read(name), /rm -rf ~\/\.config\/yonedarepo/, name);
});
