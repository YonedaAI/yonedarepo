// YonedaRepo's enterprise checks, live on dev only: a large repository's erase, the undo window
// and legal hold (docs/enterprise-plan.md sections 1-3), and the tombstone backfill's dry run.
// Prod's privacy text needs these to be true. Needs REPO_ERASE=on, LEGAL_HOLD=on and a short test
// REPO_UNDO_DAYS on dev (docs/runbook.md, "Enterprise checks").
//
// Without `--go` it prints what it would do, reads no credential and calls nothing. With it:
//   node tools/staging/dev-checks.mjs --go [--only undo,hold,erase,backfill,hold-wait]
//     [--rung kubernetes|svelte] [--import-min 120] [--erase-min 120] [--backfill-delay-ms 1000]
// `--only` defaults to undo,hold,erase,backfill. `hold-wait` takes about six hours and runs alone.
// The erase needs its source and plan on this machine, made with no platform call:
//   node tools/staging/size-ladder.mjs --rungs kubernetes --plan-only --sources .local/size-ladder/sources \
//     --state .local/dev-checks/ladder-state.json --out .local/dev-checks/ladder
//
// Signs in as the kit accounts once and keeps the sessions. Everything it makes is named
// `dev-check-…`, is the only thing it may delete (`Ledger`), and is deleted however a step ends.
// Credentials come from 0600 files in ~/.config/yonedarepo: staging-kit.env, staging.env
// (OWNER_TOKEN), deploy-dev.env (Cloudflare reads) and observability-read.env (analytics). Nothing
// is printed or written to evidence but ids and counts. Evidence: <repo root>/.local/dev-checks/<stamp>/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { accountSession, kitCredentials, OWN_TRAFFIC, readEnvFile, Recorder, secondAccount, Session, sleep } from './client.mjs';
import { backfillSteps } from './dev-checks-backfill.mjs';
import { cloudflare } from './dev-checks-cf.mjs';
import { eraseSteps } from './dev-checks-erase.mjs';
import { gitTools } from './dev-checks-git.mjs';
import { holdSteps, holdWaitSteps } from './dev-checks-hold.mjs';
import { DEV, Ledger, requireDev, rootOf, scrub } from './dev-checks-lib.mjs';
import { cleanUp, runSteps } from './dev-checks-repos.mjs';
import { undoSteps } from './dev-checks-undo.mjs';

const { values } = parseArgs({
  options: {
    go: { type: 'boolean', default: false },
    only: { type: 'string', default: 'undo,hold,erase,backfill' },
    rung: { type: 'string', default: 'svelte' },
    'import-min': { type: 'string', default: '120' },
    'erase-min': { type: 'string', default: '120' },
    'backfill-delay-ms': { type: 'string', default: '1000' },
  },
});
const only = values.only.split(',');
const known = ['undo', 'hold', 'erase', 'backfill', 'hold-wait'];
for (const name of only) if (!known.includes(name)) throw new Error(`--only: ${name} is none of ${known.join(', ')}`);

const PLAN = {
  undo: 'Undo: small public repository, 2 sign-ins shared, about 10 minutes against a short window',
  hold: 'Legal hold: a throwaway org and 4 small repositories, about 15 minutes',
  erase: `Large-repo erase: new import of ${values.rung}, tailed, then every copy read`,
  backfill: 'Backfill dry run: wakes every repository object once, one a second',
  'hold-wait': 'A held tombstone left for the sweep to come back: about 6 hours',
};
if (!values.go) {
  console.log('Nothing was run. With --go, on dev only:');
  for (const name of only) console.log(`- ${PLAN[name]}`);
  process.exit(0);
}

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
const root = rootOf(resolve(git('rev-parse', '--git-common-dir')));
const stamp = Date.now().toString(36);
const out = join(root, '.local/dev-checks', stamp);
mkdirSync(out, { recursive: true });
const secrets = new Set();
const origin = requireDev(DEV.origin);

const { KIT_USERNAME, KIT_PASSWORD } = kitCredentials();
const { OWNER_TOKEN } = readEnvFile('staging.env');
const { CLOUDFLARE_API_TOKEN } = readEnvFile('deploy-dev.env');
const { CLOUDFLARE_API_TOKEN: analyticsToken } = readEnvFile('observability-read.env', { required: false });
for (const secret of [KIT_PASSWORD, OWNER_TOKEN, CLOUDFLARE_API_TOKEN, analyticsToken]) secrets.add(secret);

const spec = JSON.parse(readFileSync(new URL('../../infra/envs/dev.json', import.meta.url), 'utf8'));
const config = readFileSync(new URL('../../cloudflare/wrangler.dev-platform.jsonc', import.meta.url), 'utf8');
const script = `${spec.prefix}-platform`;
const cloudflareEnv = { ...process.env, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: spec.account_id, WRANGLER_SEND_METRICS: 'false' };
const wranglerBin = join(root, 'node_modules/.bin/wrangler');

const tails = new Set();
/** A tail of the platform Worker filtered to `repo`, kept as evidence. */
async function tail(repo) {
  const file = join(out, `tail-${repo.id}.json`);
  const child = spawn(wranglerBin, ['tail', script, '--format', 'json', '--search', repo.id], { cwd: root, env: cloudflareEnv, stdio: ['ignore', openSync(file, 'w'), 'ignore'] });
  tails.add(child);
  await sleep(10_000);
  return {
    async stop() {
      child.kill('SIGTERM');
      tails.delete(child);
      await sleep(1000);
      return readFileSync(file, 'utf8');
    },
  };
}

/** The dry run, and nothing else: this file never sends the other flag. */
const backfillDryRun = (delayMs) =>
  new Promise((done) => {
    const child = spawn('cargo', ['xtask', 'admin', 'erase-backfill', '--env', 'dev', '--dry-run', '--delay-ms', String(delayMs)], {
      cwd: resolve(new URL('../..', import.meta.url).pathname),
      env: cloudflareEnv,
    });
    const [stdout, stderr] = [[], []];
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.on('data', (d) => stderr.push(d));
    child.on('close', (status) => {
      const answer = { status, stdout: Buffer.concat(stdout).toString(), stderr: scrub(Buffer.concat(stderr).toString(), secrets) };
      writeFileSync(join(out, 'backfill.log'), `${answer.stdout}\n${answer.stderr}\nexit=${status}\n`);
      done(answer);
    });
  });

function ladderPlan(rung) {
  const state = [join(root, '.local/dev-checks/ladder-state.json'), join(root, '.local/size-ladder/state.json')]
    .filter(existsSync)
    .map((path) => JSON.parse(readFileSync(path, 'utf8')).rungs?.[rung.name])
    .find((r) => r?.checkpoints?.length);
  const source = join(root, '.local/size-ladder/sources', `${rung.name}.git`);
  if (!state || !existsSync(source)) throw new Error(`No plan for ${rung.name}: run size-ladder.mjs --plan-only (see the top of this file)`);
  return { rung, checkpoints: state.checkpoints, source };
}

const recorder = new Recorder();
const save = () => {
  const items = JSON.parse(scrub(JSON.stringify(recorder.items), secrets));
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ stamp, items }, null, 2)}\n`);
  writeFileSync(join(out, 'results.md'), `${scrub(recorder.table(), secrets)}\n`);
};

const anon = new Session(`${origin}/api/v1`);
const { cookie, name: ownerName } = await accountSession(origin, KIT_USERNAME, KIT_PASSWORD);
const { name: memberName, session: member } = await secondAccount(origin, { KIT_USERNAME, KIT_PASSWORD });
const owner = new Session(`${origin}/api/v1`, { cookie });
const operator = new Session(`${origin}/api/v1`, { bearer: OWNER_TOKEN });
const cf = cloudflare({
  token: CLOUDFLARE_API_TOKEN,
  analyticsToken,
  account: spec.account_id,
  database: /"database_id":\s*"([0-9a-f-]{36})"/.exec(config)?.[1],
  bucket: `${script}-objects`,
  script,
});
const ctx = {
  stamp,
  secrets,
  owner,
  ownerName,
  member,
  memberName,
  operator,
  anon,
  bearer: (token) => new Session(`${origin}/api/v1`, { bearer: token }),
  cf,
  ledger: new Ledger(),
  clock: { now: Date.now, sleep },
  git: gitTools({ api: DEV.api, scratch: join(out, 'scratch'), secrets }),
  tail,
  backfillDryRun,
  evidence: (name, value) => writeFileSync(join(out, name), `${scrub(JSON.stringify(value, null, 2), secrets)}\n`),
  asset: (repo, tag, name, bytes) =>
    fetch(`${origin}/api/v1/repos/${repo.id}/releases/${tag}/assets/${name}`, { method: 'PUT', headers: { ...owner.headers({ 'content-type': 'application/octet-stream' }), ...OWN_TRAFFIC }, body: bytes }),
  knownObjects: new Set(),
};

let passed = true;
try {
  const health = await new Session(origin).raw('GET', '/health');
  ctx.evidence('health.json', health.body);
  // Each read proves its token first: an hour of import should not end on a permission.
  await cf.d1('SELECT 1 AS n');
  await cf.r2('derived/v1/none/');
  ctx.knownObjects = await cf.objects();
  console.log(`dev at ${health.body?.revision ?? 'unknown'}, ${ctx.knownObjects.size} repository objects, evidence in ${out}`);
  const flows = {
    undo: () => undoSteps(ctx),
    hold: () => holdSteps(ctx),
    erase: () => {
      const ladder = JSON.parse(readFileSync(new URL('./size-ladder.json', import.meta.url), 'utf8'));
      const rung = ladder.rungs.find((r) => r.name === values.rung);
      if (!rung) throw new Error(`No rung ${values.rung}`);
      return eraseSteps(ctx, { ...ladderPlan(rung), importMs: Number(values['import-min']) * 60_000, eraseMs: Number(values['erase-min']) * 60_000 });
    },
    backfill: () => backfillSteps(ctx, { delayMs: Number(values['backfill-delay-ms']) }),
    'hold-wait': () => holdWaitSteps(ctx),
  };
  for (const name of only) {
    passed = (await runSteps(recorder, flows[name]())) && passed;
    save();
  }
} finally {
  for (const child of tails) child.kill('SIGTERM');
  const left = await cleanUp(ctx);
  if (left.length) {
    passed = false;
    console.error(`Left behind: ${left.join(', ')}`);
  }
  ctx.evidence('left-behind.json', left);
  save();
  console.log(scrub(recorder.table(), secrets));
}
process.exit(passed ? 0 : 1);
