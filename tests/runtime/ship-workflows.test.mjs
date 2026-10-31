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
    for (const [, action] of code(text).matchAll(/uses: (\S+)/g)) if (!action.startsWith('./')) assert.match(action, /@[0-9a-f]{40}$/, action);
});

test('no workflow runs on pull_request_target or workflow_run', () => {
  for (const name of files) assert.doesNotMatch(code(read(name)), /pull_request_target|workflow_run/, name);
});

test('secrets reach only jobs with an Environment; a ship PR job needs the same repository too', () => {
  for (const name of files)
    for (const [id, job] of Object.entries(jobs(read(name))))
      if (/secrets\./.test(job)) {
        assert.match(job, /^ {4}environment: (dev|production)$/m, `${name} ${id}`);
        assert.match(job, /secrets\.YONEDA_ENV_FILE/, `${name} ${id}`);
        assert.equal([...job.matchAll(/secrets\.(\w+)/g)].filter(([, s]) => s !== 'YONEDA_ENV_FILE').length, 0, `${name} ${id}`);
      }
  const ship = jobs(read('ship.yml'));
  assert.ok(ship.gate.includes(`if: ${SAME_REPO}`));
  assert.ok(ship.dev.includes(`if: ${SAME_REPO}`));
  assert.match(ship.dev, /needs: \[check, full\]/);
  assert.doesNotMatch(ship.check + ship.full, /secrets/);
});

test('deploy and kit output reach the log only through quiet.mjs', () => {
  for (const name of ['ship.yml', 'deploy-prod.yml', 'deploy-dev.yml']) {
    const text = code(read(name));
    assert.doesNotMatch(text, /\btee\b|GITHUB_STEP_SUMMARY|set -x/, name);
    for (const line of text.split('\n'))
      if (/cargo xtask (deploy|downloads|infra)|staging-realworld/.test(line)) assert.match(line, /node tools\/ship\/quiet\.mjs (deploy|kit) -- /, line);
  }
});

test('the ship deploys and tests the PR head, one at a time, and holds dev while it does', () => {
  const text = read('ship.yml');
  assert.match(text, /^ {2}group: ship\n {2}cancel-in-progress: false$/m);
  const { dev } = jobs(text);
  assert.match(dev, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(dev, /group: deploy-dev\n\s+cancel-in-progress: false/);
  assert.match(read('deploy-dev.yml'), /^ {2}group: deploy-dev$/m);
  assert.match(dev, /uses: \.\/\.github\/actions\/env-file/);
});

test('Check and Full are reusable and keep their manual runs, in a group of their own', () => {
  for (const name of ['ci.yml', 'full.yml']) {
    const text = read(name);
    assert.match(text, /^ {2}workflow_call:$/m, name);
    assert.match(text, /^ {2}workflow_dispatch:$/m, name);
    assert.match(text, /group: \w+-\$\{\{ inputs\.ship && 'ship' \|\| /, name);
  }
  assert.match(jobs(read('ship.yml')).check, /uses: \.\/\.github\/workflows\/ci\.yml\n\s+with:\n\s+ship: true/);
  assert.match(jobs(read('ship.yml')).full, /uses: \.\/\.github\/workflows\/full\.yml\n\s+with:\n\s+ship: true/);
});

test('evidence leaves the runner gitleaks-scanned, minimal and short-lived', () => {
  const { dev } = jobs(read('ship.yml'));
  const [minimal, scan, upload] = ['tools/ship/evidence.mjs "$RUNNER_TEMP/evidence"', 'gitleaks" dir', 'upload-artifact@'].map((s) => dev.indexOf(s));
  assert.ok(minimal > 0 && minimal < scan && scan < upload);
  assert.match(dev, /path: \$\{\{ runner\.temp \}\}\/evidence/);
  const retention = Number(dev.match(/retention-days: (\d+)/)[1]);
  assert.ok(retention <= 7, `${retention}`);
  assert.doesNotMatch(dev, /path: \.local/);
});

test('prod deploys on push to main, keeps a manual re-run and the owner gate', () => {
  const text = read('deploy-prod.yml');
  assert.match(text, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(text, /^ {2}workflow_dispatch:$/m);
  const job = jobs(text);
  assert.match(job.gate, /github\.actor != 'MagnetonIO'/);
  assert.match(job.gate, /github\.ref != 'refs\/heads\/main'/);
  assert.match(job.deploy, /needs\.gate\.outputs\.ship == 'true'/);
  for (const id of ['deploy', 'downloads', 'smoke', 'monitor']) assert.match(job[id], /^ {4}environment: production$/m, id);
  assert.match(job.smoke, /--prod --only 0,browser,26,12,13,14,15,16,17/);
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
  for (const name of ['ship.yml', 'deploy-prod.yml', 'deploy-dev.yml']) assert.match(read(name), /rm -rf ~\/\.config\/yonedarepo/, name);
});
