// Archive stage A's measurement (docs/load-testing.md, "Archive stage A"): what its four switches
// save and cost, on a real-history repository imported for it. Written before a run, so its
// numbers are checked. Each arm has a repository of its own, so one arm's rows can't change the
// other's, and the switches apply to new writes only, so nothing but the workload is measured.
// Every time here is an estimate.
import { readFileSync } from 'node:fs';

export const SWITCHES = ['CHECK_EVIDENCE_ONCE', 'REF_CHAIN_SHARED', 'SHARD_FORGET_RECORDED', 'COMPACTION_SWEEP'];
/** The owner's dev test repositories: read, never written. */
export const PROTECTED = ['oss-click', 'oss-commander', 'oss-cobra', 'testing', 'claude-code-fresh'];
/** The only repositories this tool writes to, makes or deletes. */
export const PREFIX = 'archive-measure-';
export const ARMS = ['off', 'on'];
export const MIN_RUNS = 3;
/** express: 6,183 commits and 3,913 on main's first-parent chain (counted 2026-11-01), so a
 * branch copies thousands of rows without reaching the 5,000-row bound. */
export const DEFAULTS = { runs: MIN_RUNS, branches: 20, landings: 200, checks: 4, source: 'expressjs/express' };
/** Not required, so nothing gates a landing; a run is asked for by name. */
export const POLICY = { required_checks: [], approvals: 0, runners: { unit: { command: ['sh', '-c', 'echo measured'], timeout_seconds: 120 } } };
export const CHECK_NAME = 'unit';
const IMPORT_SECONDS = 180;
const SHARD_READ = 64;

export const repoName = (arm, stamp) => `${PREFIX}${arm}-${stamp}`;

/** Refuses anything that isn't this tool's own repository, whatever a saved file says. */
export function requireMeasured(name) {
  if (!name?.startsWith(PREFIX) || PROTECTED.includes(name)) throw new Error(`Refusing to write to ${name}: only ${PREFIX}* repositories`);
  return name;
}

/** Requests one run sends: a move and a commit per branch, a token, commit and landing per
 * landing, a start and about 10 looks per check, 4 size reads, and looks while it settles. */
export function runRequests(o) {
  const sizeRead = 2 + SHARD_READ;
  return o.branches * 2 + o.landings * 3 + o.checks * 11 + 4 * sizeRead + 60;
}

export function estimate(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const seconds = o.branches * 2 + 60 + o.landings * 0.1 + 150 + 60;
  const perRun = Math.ceil(seconds / 60);
  return {
    runs_per_arm: o.runs,
    requests_per_run: runRequests(o),
    minutes_per_run: perRun,
    minutes_per_arm: Math.ceil(IMPORT_SECONDS / 60) + perRun * o.runs,
    requests_all: ARMS.length * o.runs * runRequests(o),
    container_runs_all: ARMS.length * o.runs * o.checks,
    ...o,
  };
}

export function describe(e) {
  return [
    `Archive stage A: ${e.runs_per_arm} runs in each of ${ARMS.length} arms, each on its own import of ${e.source}.`,
    `One run: ${e.branches} branches, ${e.landings} landings, ${e.checks} check runs. About ${e.requests_per_run} requests and ${e.minutes_per_run} minutes; an arm about ${e.minutes_per_arm} minutes with its import.`,
    `Both arms: about ${e.requests_all} requests and ${e.container_runs_all} container check runs, under $0.25 at list price. No model. A deploy with the switches comes between the arms.`,
  ].join('\n');
}

/** The change `--arm on` needs, as it goes in `infra/envs/dev.json`: the platform Worker's `vars`. */
export const DEV_JSON_CHANGE = SWITCHES.map((name) => `"${name}": "on"`).join(',\n');

/** What dev's spec in this checkout says of the switches: `on`, or absent and so off. */
export function specSwitches(text = readFileSync(new URL('../../infra/envs/dev.json', import.meta.url), 'utf8')) {
  const { workers } = JSON.parse(text);
  const vars = workers.find((w) => w.role === 'platform')?.config?.vars ?? {};
  return Object.fromEntries(SWITCHES.map((name) => [name, vars[name] === 'on' ? 'on' : 'off']));
}

/** Refuses an arm this checkout's spec doesn't describe: a measurement labelled with the wrong
 * switches would read as a result. It proves what the spec says, not what is deployed. */
export function requireArm(arm, switches = specSwitches()) {
  const wrong = SWITCHES.filter((name) => switches[name] !== arm);
  if (wrong.length) throw new Error(`Arm ${arm} needs ${wrong.join(', ')} ${arm} in infra/envs/dev.json, deployed`);
}
