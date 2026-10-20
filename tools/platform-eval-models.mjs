#!/usr/bin/env node
// N9 real-model arms: an explicit, separate, PAID command (never part of local gates).
// It drives the deployed eval Worker (agent-layer side; model keys stay in its Secrets
// Store bindings) against the isolated platform-only Worker. This script only creates
// repositories and per-repo tokens as the platform test account, then asks the eval
// Worker to run each arm; the Worker enforces the total spend cap before every request.
// Phases: smoke (one tiny request per provider), small (one 2-task arm per working
// provider), full (Study A grid + faulted arm + P9, only when projected spend fits), p9
// (the hosted check preflight and P9 alone, e.g. after a preflight timeout).
// Writes .local/platform-eval/model-arms-<phase>-<providers>-<run>.json; a full run resumes
// from earlier saved runs, skipping finished grid arms. Credentials: YONEDA_USERNAME /
// YONEDA_PASSWORD; the eval bearer secret is read from a 0600 file, never printed.
// Usage: node tools/platform-eval-models.mjs --eval-url URL --platform-url URL
//          --token-file FILE --phase smoke|small|full|p9 [--providers zai,mimo]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { codebase, INTERFACES, LAYOUTS, render } from '../cloudflare/eval/study.ts';

const { values } = parseArgs({
  options: {
    'eval-url': { type: 'string' },
    'platform-url': { type: 'string' },
    'token-file': { type: 'string' },
    phase: { type: 'string', default: 'smoke' },
    providers: { type: 'string', default: 'zai,mimo' },
    // Re-run P9 schedulers even if an earlier saved run judged them.
    fresh: { type: 'boolean', default: false },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const evalUrl = values['eval-url']?.replace(/\/$/, '');
const platformUrl = values['platform-url']?.replace(/\/$/, '');
assert.ok(evalUrl && platformUrl && values['token-file'], 'Pass --eval-url, --platform-url and --token-file');
assert.ok(['smoke', 'small', 'full', 'p9'].includes(values.phase), 'phase is smoke, small, full or p9');
assert.equal(statSync(values['token-file']).mode & 0o077, 0, 'The token file must be private (0600)');
const secret = readFileSync(values['token-file'], 'utf8').trim();
const SEED = 20261019;
const TOTAL_CAP_USD = 5;
// Official pricing pages checked on this date; the eval Worker bills at the registry's
// rates for these models, which matched the pages.
const PRICING_CHECK = {
  verified_at: '2026-10-20',
  zai: { model: 'glm-5.3-flash', input_usd_per_million: 0.15, output_usd_per_million: 0.5, cached_input_usd_per_million: 0.03, source: 'https://docs.z.ai/guides/overview/pricing' },
  mimo: { model: 'mimo-v2.6-flash', input_usd_per_million: 0.14, output_usd_per_million: 0.28, cached_input_usd_per_million: 0.0028, source: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go' },
  basis: 'Metered-equivalent pay-as-you-go rates; cache reads and writes billed at the full input rate (conservative). Coding Plan / Token Plan usage is subscription quota, not a token invoice.',
};

async function evalCall(path, body) {
  const response = await fetch(`${evalUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25 * 60_000),
  });
  // Arm responses stream: headers at once, keepalive spaces, then the JSON result.
  const value = await response.json().catch(() => ({ error: { code: 'BAD_RESPONSE' } }));
  if (!response.ok || value.error) throw new Error(`${path}: ${response.status} ${value.error?.code} ${value.error?.message}`);
  return value;
}

async function signIn() {
  const login = await fetch(`${platformUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
  });
  assert.equal(login.status, 200, 'Platform login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
  return (login.headers.get('set-cookie') ?? '').split(';')[0];
}
let cookie = await signIn();
async function platform(path, body, retried = false) {
  const response = await fetch(`${platformUrl}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  // The shared test account's sessions can be evicted by other sign-ins: sign in again once.
  if (response.status === 401 && !retried) {
    cookie = await signIn();
    return platform(path, body, true);
  }
  if (!response.ok) throw new Error(`${path}: ${value.error?.code} ${value.error?.message}`);
  return value;
}
const b64 = (text) => Buffer.from(text).toString('base64');
const author = { name: 'N9 eval driver', email: 'eval@yonedarepo.invalid' };
const token = async (repo, name) => (await platform(`/repos/${repo}/tokens`, { name, scopes: ['read', 'write', 'land'] })).token;
async function repoWith(name, files, policy = { required_checks: [], approvals: 0 }) {
  return platform('/repos', { name, policy, files: files.map(([path, text]) => ({ path, content_b64: b64(text) })), author });
}

const run = `n9-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
const providers = values.providers.split(',');
const report = { schema: 1, run, phase: values.phase, started_at: new Date().toISOString(), smoke: [], arms: [], p9: [], skipped: [] };
report.spend_before = await evalCall('/v1/spend');
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

for (const provider of providers) {
  const result = await evalCall('/v1/smoke', { run, provider });
  log(`smoke ${provider}: ${result.ok ? 'ok' : `FAILED ${result.error}`} via ${result.route} (${result.usage.requests} request, ${JSON.stringify(result.usage.failures)})`);
  report.smoke.push(result);
}
const working = report.smoke.filter((s) => s.ok).map((s) => s.provider);
// Earlier runs' saved arms: a full run resumes, skipping grid arms that already finished.
const output = resolve(root, '.local/platform-eval');
await mkdir(output, { recursive: true, mode: 0o700 });
const armKey = (provider, layout, iface, dropRate) => `${provider}/${layout}/${iface}/${dropRate}`;
const earlierRuns = readdirSync(output)
  .filter((name) => /^model-arms-(full|p9)-.+\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(resolve(output, name), 'utf8')));
const saved = earlierRuns.flatMap((r) => r.arms);
const p9Done = new Set(
  earlierRuns.flatMap((r) => r.p9).filter((r) => ['pass', 'fail'].includes(r.head_check)).map((r) => `${r.provider}/${r.scheduler_id}`),
);
const done = new Set(
  saved.filter((a) => a.tasks_planned === 6 && !a.stopped).map((a) => armKey(a.provider, a.layout, a.interface, a.drop_rate)),
);

report.failed = [];
/** A failed arm is recorded (its spend is in the ledger) and the run continues. */
async function attempt(label, work) {
  try {
    return await work();
  } catch (e) {
    log(`FAILED ${label}: ${e.message}`);
    report.failed.push({ arm: label, error: String(e.message).slice(0, 300) });
    return null;
  }
}

async function arm(provider, layout, iface, tasks, dropRate = 0) {
  if (tasks === 6 && done.has(armKey(provider, layout, iface, dropRate))) return log(`${provider} ${layout}/${iface} ${dropRate}: done in an earlier run`);
  return attempt(`${provider} ${layout}/${iface}${dropRate ? ` faults ${dropRate}` : ''}`, () => runArm(provider, layout, iface, tasks, dropRate));
}
async function runArm(provider, layout, iface, tasks, dropRate) {
  const repo = await repoWith(`n9-${provider}-${layout}-${iface}-${Date.now()}`, render(layout, codebase(SEED)));
  const result = await evalCall('/v1/arms', { run, provider, layout, interface: iface, seed: SEED, tasks, drop_rate: dropRate, repo: repo.id, token: await token(repo.id, 'model-agent') });
  log(`${provider} ${layout}/${iface}${dropRate ? ` faults ${dropRate}` : ''}: accepted ${result.accepted}/${result.tasks}, recall ${result.closure_recall.toFixed(2)}, precision ${result.exposure_precision.toFixed(2)}, $${result.usage.usd}, failures ${JSON.stringify(result.usage.failures)}${result.stopped ? `, STOPPED ${result.stopped}` : ''}`);
  report.arms.push({ repo: repo.id, ...result });
  return result;
}

const PRICING = 'export function price(amount: number): number {\n  return amount;\n}\n';
const CART = 'export function total(items: number[]): number {\n  return items.length;\n}\n';
const TSCONFIG = '{\n  "compilerOptions": { "strict": true, "noEmit": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" },\n  "include": ["src"]\n}\n';
// The repository's own type check, run by the platform after every landing (check container).
const P9_POLICY = { required_checks: [], approvals: 0, runners: { combined: { command: ['node', '/opt/yoneda/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], timeout_seconds: 180 } } };
const P9_FILES = [['src/pricing.ts', PRICING], ['src/cart.ts', CART], ['tsconfig.json', TSCONFIG]];

/** Same rule as the eval Worker: executor errors (no container capacity) are re-requested. */
async function headCheck(repo, commit) {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const detail = await platform(`/repos/${repo}/commits/${commit}`);
    const status = detail.checks?.find((c) => c.name === 'combined')?.status;
    if (['pass', 'fail', 'error'].includes(status)) return status;
    const runs = (detail.check_runs ?? []).filter((r) => r.name === 'combined');
    const lastError = Math.max(0, ...runs.map((r) => Number(r.finished_at ?? 0)));
    if (runs.length > 0 && runs.every((r) => r.status === 'errored') && Date.now() - lastError >= 30_000) {
      if (runs.length > 3) return `error (executor: ${JSON.parse(runs.at(-1).result ?? '{}').error ?? 'unknown'})`.slice(0, 160);
      await platform(`/repos/${repo}/commits/${commit}/check-runs`, { name: 'combined' });
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return 'timeout';
}
/** No-model preflight: a correct call passes and a wrong-arity call fails the hosted check. */
async function p9Preflight() {
  const repo = await repoWith(`n9-p9-preflight-${Date.now()}`, P9_FILES, P9_POLICY);
  const verdicts = [];
  for (const call of ['price(5)', "price(5, 'usd')"]) {
    const cart = `import { price } from './pricing';\n${CART}\nexport function shipping(): number {\n  return ${call};\n}\n`;
    const made = await platform(`/repos/${repo.id}/commits`, { ref: 'main', changes: [{ path: 'src/cart.ts', content_b64: b64(cart) }], message: `Preflight ${call}`, author });
    await platform(`/repos/${repo.id}/land`, { ref: 'main', commit: made.commit });
    verdicts.push(await headCheck(repo.id, made.commit));
  }
  return { repo: repo.id, verdicts, ok: verdicts[0] === 'pass' && verdicts[1] === 'fail' };
}

async function p9(provider, scheduler) {
  if (!values.fresh && p9Done.has(`${provider}/${scheduler}`)) return log(`${provider} P9 ${scheduler}: done in an earlier run`);
  return attempt(`${provider} P9 ${scheduler}`, () => runP9(provider, scheduler));
}
async function runP9(provider, scheduler) {
  const repo = await repoWith(`n9-p9-${provider}-${scheduler}-${Date.now()}`, P9_FILES, P9_POLICY);
  const tokens = { a: await token(repo.id, 'agent-a'), b: await token(repo.id, 'agent-b') };
  const result = await evalCall('/v1/p9', { run, provider, scheduler, repo: repo.id, tokens, base: { commit: repo.commit, version: repo.version } });
  log(`${provider} P9 ${scheduler}: check ${result.head_check}, accepted ${result.accepted}/2, conflicts ${result.stale_read_conflicts}, attempts ${result.agent_attempts}, $${result.usage.usd}${result.stopped ? `, STOPPED ${result.stopped}` : ''}`);
  report.p9.push({ repo: repo.id, scheduler_id: scheduler, ...result });
}

if (values.phase === 'p9') {
  const preflight = await p9Preflight();
  log(`P9 hosted check preflight: ${JSON.stringify(preflight.verdicts)}`);
  report.p9_preflight = preflight;
  if (preflight.ok) for (const provider of working) for (const scheduler of ['disjoint', 'aware', 'planned']) await p9(provider, scheduler);
  else report.skipped.push({ reason: 'P9 skipped: the hosted combined check preflight did not pass/fail as expected' });
} else if (values.phase !== 'smoke') {
  const perTask = {};
  for (const provider of working) {
    const earlier = saved.find((a) => a.provider === provider && a.tasks > 0);
    const small = earlier ?? (await arm(provider, 'modules', 'symbol', 2));
    if (small) perTask[provider] = small.usage.usd / Math.max(1, small.tasks);
  }
  if (values.phase === 'full') {
    const preflight = await p9Preflight();
    log(`P9 hosted check preflight: ${JSON.stringify(preflight.verdicts)}`);
    report.p9_preflight = preflight;
    for (const provider of working.filter((p) => p in perTask)) {
      const spend = await evalCall('/v1/spend');
      const committed = (spend.settled_microusd + spend.open_reservations_microusd) / 1e6;
      // 36 grid tasks + 6 faulted + ~7 P9 agent runs, with a 2x margin for longer contexts.
      const projected = perTask[provider] * 49 * 2;
      if (committed + projected > TOTAL_CAP_USD) {
        report.skipped.push({ provider, reason: `projected $${projected.toFixed(3)} on top of $${committed.toFixed(3)} exceeds the $${TOTAL_CAP_USD} cap` });
        log(`SKIP ${provider} full grid: projected spend exceeds the cap`);
        continue;
      }
      for (const layout of LAYOUTS) for (const iface of INTERFACES) await arm(provider, layout, iface, 6);
      await arm(provider, 'modules', 'symbol', 6, 0.3);
      if (preflight.ok) for (const scheduler of ['disjoint', 'aware', 'planned']) await p9(provider, scheduler);
      else report.skipped.push({ provider, reason: 'P9 skipped: the hosted combined check preflight did not pass/fail as expected' });
    }
  }
}

report.spend_after = await evalCall('/v1/spend');
report.finished_at = new Date().toISOString();
report.manifest = {
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  eval_worker: { name: 'yonedarepo-eval-dev', url: evalUrl },
  platform_worker: { name: 'yonedarepo-platform-dev', url: platformUrl, health: await (await fetch(`${platformUrl}/health`)).json() },
  models: report.smoke.map((s) => ({ provider: s.provider, model: s.model, route: s.route, smoke_ok: s.ok })),
  pricing: PRICING_CHECK,
  caps: { total_usd: TOTAL_CAP_USD, enforced_by: 'eval Worker SpendLedger (projected cost reserved before every request)', ...(report.arms[0]?.limits ?? {}) },
  seeds: { study_a: SEED, search_faults: SEED + 1, tasks_per_arm: 6 },
  prompts_sha256: report.arms[0]?.prompts_sha256 ?? report.p9[0]?.prompts_sha256 ?? null,
};
// This run's own requests (parallel runs share the ledger, so its delta is not ours alone).
const spent =
  report.smoke.reduce((sum, s) => sum + s.usage.microusd / 1e6, 0) +
  [...report.arms, ...report.p9].reduce((sum, a) => sum + a.usage.usd, 0);
report.total_usd = Number(spent.toFixed(6));
log(`spent $${report.total_usd} this run; ledger total $${report.spend_after.settled_microusd / 1e6} of $${report.spend_after.cap_microusd / 1e6}`);
await writeFile(resolve(output, `model-arms-${values.phase}-${providers.join('+')}-${run}.json`), `${JSON.stringify(report, null, 2)}\n`);
