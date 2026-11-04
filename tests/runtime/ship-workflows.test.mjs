// Pins the rules of the workflows on a public repository (docs/ship-pipeline.md). GitHub is the
// only real test of a workflow; these catch the mistakes that would leak or deploy by accident.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

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

test('every action is pinned by commit', () => {
  for (const text of [...files.map(read), ...actions])
    for (const [, action] of code(text).matchAll(/^\s*(?:- )?uses: (\S+)/gm)) if (!action.startsWith('./')) assert.match(action, /@[0-9a-f]{40}$/, action);
});

test('CI validates PRs or manual requests; only Deploy prod handles main pushes', () => {
  const ci = code(read('ci.yml'));
  assert.match(ci, /^ {2}pull_request:$/m);
  assert.match(ci, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(ci, /^ {2}push:$/m);
  assert.match(code(read('deploy-prod.yml')), /^ {2}push:\n {4}branches: \[main\]$/m);
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

test('exactly CI, Deploy prod and manual Deploy dev are defined; Nightly is removed', () => {
  assert.deepEqual(files.sort(), ['ci.yml', 'deploy-dev.yml', 'deploy-prod.yml']);
  assert.match(read('ci.yml'), /^name: CI$/m);
  assert.doesNotMatch(code(read('deploy-dev.yml')), /push:|pull_request:|schedule:/);
  const deep = readFileSync(join(ROOT, 'docs/code-health.md'), 'utf8');
  assert.match(deep, /cargo test -p yoneda-platform --lib differential -- --ignored/);
});

test('CI owns secret-free fast and full release validation with a final Ship gate', () => {
  const text = read('ci.yml'), ci = jobs(text);
  assert.doesNotMatch(code(text), /secrets\.|environment:|xtask deploy|staging-realworld|workflow_call:/);
  assert.match(ci.scope, /github\.event_name == 'pull_request'/);
  assert.match(ci.scope, /github\.base_ref == 'main'/);
  assert.match(ci.scope, /github\.head_ref == 'dev'/);
  assert.match(ci.scope, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(ci['ship-tree'], /HEAD\^\{tree\}/);
  assert.match(ci['ship-tree'], /PR_HEAD\^\{tree\}/);
  assert.match(ci['ship-gate'], /^ {4}name: Ship gate$/m);
  for (const id of ['scope', 'ship-tree', 'check', 'wasm', 'workers-total', 'suites', 'image'])
    assert.ok(ci['ship-gate'].includes(id), id);
  assert.match(ci['ship-gate'], /always\(\) && github\.event_name == 'pull_request'/);
  assert.match(ci['ship-gate'], /github\.base_ref == 'main'/);
  assert.doesNotMatch(ci['ship-gate'].split('runs-on:')[0], /needs\.scope\.outputs/, 'scope failure must still run and fail the required gate');
  assert.match(ci['ship-gate'], /toJSON\(needs\)/);
  assert.match(ci['ship-gate'], /ci-scope\.mjs --gate/);
  assert.match(ci['workers-total'], /needs.workers.result/);
  assert.match(ci.suites, /pnpm test:storage-full/);
});

test('release CI runs partitioned functional coverage, four fail-closed shards and the conditional runtime image', () => {
  const ci = jobs(read('ci.yml'));
  for (const id of ['wasm', 'image']) {
    assert.match(ci[id], /needs: \[scope, ship-tree\]/);
    assert.match(ci[id], /!cancelled\(\).*needs\.scope\.outputs\.full == 'true'/);
  }
  for (const id of ['workers', 'suites']) {
    assert.match(ci[id], /needs: \[scope, wasm\]/);
    assert.match(ci[id], /if: needs\.scope\.outputs\.full == 'true'/);
  }
  assert.match(ci.workers, /shard: \[1, 2, 3, 4\]/);
  assert.match(ci.workers, /fail-fast: false/);
  assert.match(ci.workers, /node tools\/ci\/workers\.mjs platform --shard=/);
  assert.doesNotMatch(ci.suites, /pnpm test:platform/);
  assert.match(ci['workers-total'], /if: always\(\) && needs\.scope\.outputs\.full == 'true'/);
  assert.match(ci['workers-total'], /\$\{#files\[@\]\}.*-ne 4/);
  for (const command of ['node tools/ci/workers.mjs main', 'pnpm test:storage-full', 'pnpm test:superfan', 'pnpm test:managed'])
    assert.ok(ci.suites.includes(command), command);
  assert.match(ci.wasm, /worker-build --release/);
  assert.match(ci.image, /git diff --quiet origin\/main\.\.\.HEAD -- cloudflare\/containers backend\/crates\/yoneda-runtime/);
  assert.match(ci.image, /ASKED: \$\{\{ inputs\.image \}\}/);
  assert.match(ci.image, /outputs: type=cacheonly/);
  assert.match(ci.image, /DOCKER_BUILD_RECORD_UPLOAD: 'false'/);
});

test('no kit runs on GitHub and no evidence leaves the Mac', () => {
  for (const name of files) {
    assert.doesNotMatch(code(read(name)), /staging-realworld/, name);
    if (name === 'deploy-prod.yml') {
      for (const [id, body] of Object.entries(jobs(read(name))))
        if (!['cli-build', 'downloads'].includes(id)) assert.doesNotMatch(body, /upload-artifact|download-artifact|gh run download/, id);
      assert.doesNotMatch(jobs(read(name))['cli-build'], /path:.*(?:\.local|evidence|session|logs)/);
    } else if (name !== 'ci.yml') assert.doesNotMatch(code(read(name)), /upload-artifact|download-artifact|gh run download/, name);
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

test('CI manual full validation and PR cancellation stay separate from noncancelable deployment', () => {
  const ci = read('ci.yml');
  assert.match(ci, /^ {2}workflow_dispatch:$/m);
  assert.match(ci, /^ {6}full:$/m);
  assert.match(ci, /Force the runtime image build when full validation is selected/);
  assert.match(ci, /group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(ci, /cancel-in-progress: true/);
  assert.match(read('deploy-prod.yml'), /group: deploy-prod\n {2}cancel-in-progress: false/);
  assert.doesNotMatch(code(read('deploy-prod.yml')), /pull_request:/);
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
  assert.doesNotMatch(job.deploy, /statuses: read/);
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

// Full validation shares one Wasm artifact and the Check frontend build.
test('Check shares full-lane Wasm, but fails closed unless fast Wasm was intentionally skipped', () => {
  const ci = jobs(read('ci.yml'));
  assert.match(ci.check, /needs: \[scope, wasm\]/);
  assert.match(ci.check, /!cancelled\(\)/);
  assert.match(ci.check, /needs\.wasm\.result == 'success'/);
  assert.match(ci.check, /needs\.scope\.outputs\.full != 'true' && needs\.wasm\.result == 'skipped'/);
  assert.match(ci.check, /download-artifact/);
  assert.match(ci.check, /if: needs\.scope\.outputs\.full != 'true'/);
  assert.match(ci.check, /if: needs\.scope\.outputs\.full == 'true'/);
  assert.match(ci.check, /pnpm --dir frontend build/);
  assert.doesNotMatch(ci.suites, /pnpm --dir frontend build/);
  const condition = ci.check.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)?.[1];
  assert.ok(condition);
  const allowed = (full, wasm, check = 'true', cancelled = false) => runInNewContext(condition, {
    needs: { scope: { outputs: { full, check } }, wasm: { result: wasm } }, cancelled: () => cancelled,
  }, { timeout: 50 });
  for (const full of ['true', 'false']) {
    assert.equal(allowed(full, 'success'), true);
    for (const result of ['failure', 'cancelled', undefined]) assert.equal(allowed(full, result), false);
    assert.equal(allowed(full, 'success', 'false'), false);
    assert.equal(allowed(full, 'success', 'true', true), false);
  }
  assert.equal(allowed('true', 'skipped'), false, 'full release cannot use a missing artifact');
  assert.equal(allowed('false', 'skipped'), true, 'fast checks build their own Wasm');
});


test('tooling Check runs only artifact-free tooling commands while ordinary and full app checks remain', () => {
  const ci = jobs(read('ci.yml'));
  assert.match(ci.scope, /tooling: \$\{\{ steps\.paths\.outputs\.tooling \}\}/);
  assert.match(ci.scope, /full: \$\{\{ steps\.paths\.outputs\.full \}\}/);
  assert.match(ci.scope, /BASE: \$\{\{ github\.event\.pull_request\.base\.sha/);
  assert.match(ci.scope, /HEAD: \$\{\{ github\.sha \}\}/);
  assert.match(ci.scope, /MANUAL_FULL: .*workflow_dispatch.*inputs\.full/);
  const steps = ci.check.split(/^ {6}- /m).slice(1);
  const runs = (needle, tooling, full) => {
    const step = steps.find(step => step.includes(needle));
    assert.ok(step, needle);
    const condition = step.match(/^ {8}if: (.+)$/m)?.[1];
    return !condition || runInNewContext(condition, { needs: { scope: { outputs: { tooling, full } } } }, { timeout: 50 });
  };
  for (const command of ['run: cargo fmt --all --check', 'run: cargo test -p xtask --bins', 'run: cargo xtask layers', 'name: Health gates'])
    assert.equal(runs(command, 'true', 'false'), true, command);
  assert.equal(runs('run: cargo clippy -p xtask --all-targets', 'true', 'false'), true);
  for (const command of ['run: cargo clippy --workspace', 'run: cargo test -p yoneda-core', 'run: cargo fmt --check --manifest-path', 'run: cargo clippy --manifest-path', 'run: cargo test --manifest-path', 'run: pnpm check', 'run: pnpm --dir frontend exec tsc', 'run: pnpm --dir frontend build', 'run: cargo xtask health size', 'run: pnpm test:frontend', 'run: pnpm test:runtime']) {
    assert.equal(runs(command, 'true', 'false'), false, command);
    assert.equal(runs(command, 'false', 'false'), true, command);
    assert.equal(runs(command, 'false', 'true'), true, command);
  }
  for (const full of ['true', 'false']) assert.equal(runs('name: worker-build --release', 'true', full), false);
  assert.equal(runs('name: worker-build --release', 'false', 'false'), true);
  assert.equal(runs('name: worker-build --release', 'false', 'true'), false);
  const toolingStep = steps.find(step => step.includes('name: Tooling runtime checks'));
  assert.equal(runs('name: Tooling runtime checks', 'true', 'false'), true);
  assert.equal(runs('name: Tooling runtime checks', 'false', 'true'), false);
  assert.match(toolingStep, /git ls-files -z -- 'tests\/runtime\/\*\.test\.mjs' ':\(exclude\)tests\/runtime\/binding-streams\.test\.mjs'/);
  assert.match(toolingStep, /test "\$\{#files\[@\]\}" -gt 0/);
  assert.match(toolingStep, /node --test "\$\{files\[@\]\}"/);
});
test('CLI publication builds all targets without secrets, then assembles and publishes one complete cohort', () => {
  const job = jobs(read('deploy-prod.yml'));
  assert.ok(job['cli-build']);
  assert.match(job['cli-build'], /max-parallel: 3/);
  assert.match(job['cli-build'], /fail-fast: false/);
  assert.doesNotMatch(job['cli-build'], /environment: production|secrets\.|actions\/env-file/);
  const rust = readFileSync(join(ROOT, 'xtask/src/downloads.rs'), 'utf8');
  const targets = [...rust.matchAll(/\("([a-z0-9-]+)", "([a-z0-9_-]+)", (true|false)\)/g)].map(m => [m[1], m[2]]);
  assert.equal(targets.length, 6);
  for (const [target, triple] of targets) {
    assert.ok(job['cli-build'].includes(`target: ${target}`), target);
    assert.ok(job['cli-build'].includes(`triple: ${triple}`), triple);
  }
  assert.match(job['cli-build'], /Swatinem\/rust-cache@[a-f0-9]{40}/);
  assert.match(job['cli-build'], /hashFiles\('rust-toolchain.toml', 'Cargo.lock'\)/);
  assert.match(job['cli-build'], /--targets "\$CLI_TARGET" --revision "\$SOURCE_REVISION"/);
  assert.match(job['cli-build'], /name: cli-\$\{\{ matrix.target \}\}-\$\{\{ github.sha \}\}/);
  const artifactPaths = job['cli-build'].match(/^ {10}path: \|\n((?: {12}.+\n)+)/m)?.[1].trim().split('\n').map(line => line.trim());
  assert.deepEqual(artifactPaths, ['target/downloads/prod/receipt.json', 'target/downloads/prod/cli/*/yoneda-*-${{ matrix.target }}.*']);
  assert.equal((job['cli-build'].match(/uses: actions\/upload-artifact@/g) ?? []).length, 1);
  assert.match(job.downloads, /needs: \[deploy, cli-build\]/);
  assert.match(job.downloads, /needs.cli-build.result == 'success'/);
  assert.match(job.downloads, /environment: production/);
  assert.ok(job.downloads.indexOf('downloads assemble') < job.downloads.indexOf('downloads upload'));
  assert.match(job.downloads, /--from target\/cli-input --revision "\$SOURCE_REVISION"/);
  assert.doesNotMatch(job.downloads, /downloads stage|cargo zigbuild|cargo install cargo-zigbuild/);
});
