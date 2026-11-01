// What the Flight Path items share (43: flight-path-flow.mjs, 44: flight-failures-flow.mjs, 45:
// flight-agent-flow.mjs): a repository with the Landings switches on, the tokens a flight's crew
// holds, and each leg timed and recorded, so a failure says which step stopped the flight.
import assert from 'node:assert/strict';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { kitRepo, pushWork, refusal, settled } from './feature-kit.mjs';
import { LWC_OFF } from './land-cleared-flow.mjs';

export const CI = 'flight-ci';
export const ACTOR = 'platform:land-when-cleared';
/** A queue job, a Worker's cold start and a retry. */
export const QUEUE_MS = 90_000;
/** Time for a job that must not land anything to have run, had it been going to. */
export const SETTLE_MS = 8_000;
const RULES = { approvals: 1, required_checks: [CI] };

/** `run(n, title, body)`: times one leg into `m.legs`; a failure names the leg it stopped on. */
export function legs(m) {
  m.legs = [];
  return async (step, title, body) => {
    const started = performance.now();
    const leg = { step, title, ms: 0, result: 'failed' };
    m.legs.push(leg);
    try {
      leg.result = String((await body()) ?? 'ok');
    } catch (e) {
      leg.error = e.message;
      m.stopped_at = `${step}: ${title}`;
      throw Object.assign(e, { message: `Step ${step} (${title}): ${e.message}` });
    } finally {
      leg.ms = Math.round(performance.now() - started);
      console.log(`  ${String(step).padEnd(5)} ${title}: ${leg.error ? `FAILED ${leg.error.slice(0, 200)}` : leg.result} (${leg.ms} ms)`);
    }
  };
}

/** A repository with `switches` on, the rules a flight needs unless `policy` says otherwise, and
 * the crew: `ci` posts the required check, `agent` is a review agent's token, `pilot` writes.
 * `{ skip }` while Land when cleared is off on the platform. */
export async function flightRepo(kit, prefix, { switches = {}, policy = RULES, files } = {}) {
  const api = kit.pat();
  const repo = await kitRepo(kit, prefix, { policy, ...(files ? { files } : {}) });
  const on = await api.raw('PUT', repo.path('/auto-landings'), { land_when_cleared: true, ...switches });
  if (on.body?.error?.code === 'NOT_SUPPORTED') return { skip: LWC_OFF };
  assert.ok(on.ok, `the switches: ${refusal(on)}`);
  const mint = async (name, scopes) => (await api.post(repo.path('/tokens'), { name, scopes })).token;
  const crew = {
    ci: kit.pat(await mint('kit-ci', ['read', `check:${CI}`])),
    agent: kit.pat(await mint('kit-review-agent', ['read', 'review', 'check'])),
    pilot: await mint('kit-pilot', ['read', 'write']),
  };
  return { repo, crew };
}

/** The pilot's environment: its own token, in a coding session or none. */
export const pilotEnv = (kit, token, session, extra = {}) =>
  kit.env({ ...NO_SESSION, YONEDA_TOKEN: token, ...(session ? { YONEDA_SESSION_ID: `claude-code:${session}` } : {}), ...extra });

export const change = (kit, repo, number) => kit.pat().get(repo.path(`/changes/${number}`));
export const gates = (kit, repo, number) => kit.pat().get(repo.path(`/changes/${number}/gates`));
export const passCheck = (session, repo, head, name = CI, evidence) => session.post(repo.path(`/commits/${head}/checks`), { name, status: 'pass', ...(evidence ? { evidence } : {}) });
export const review = (reviewer, repo, head, decision = 'approve') => reviewer.session.post(repo.path(`/commits/${head}/reviews`), { decision });

/** The open Landing on `branch`, once a push has opened it. */
export const landingOf = (kit, repo, branch) =>
  settled(async () => {
    const { changes } = await kit.pat().get(repo.path('/changes?status=open'));
    return changes.find((c) => c.branch === branch);
  }, `the Landing of ${branch}`);

/** Work pushed on `branch`, with the Landing the push opened; answers `{ number, head }`. */
export async function pushedLanding(kit, repo, dir, spec) {
  const head = await pushWork(kit, dir, spec);
  const { number } = await landingOf(kit, repo, spec.branch);
  return { number, head };
}

/** Landing `number` once it reads landed. */
export const landedOf = (kit, repo, number, what = 'CTC to land it') =>
  settled(async () => {
    const read = await change(kit, repo, number);
    return read.status === 'landed' && read;
  }, what, QUEUE_MS);

/** The newest decision CTC recorded on `head` that names `code`. */
export const decisionOn = (kit, repo, number, head, code) =>
  settled(async () => {
    const { clearances = [] } = await change(kit, repo, number);
    return clearances.find((c) => c.head === head && c.reasons.some((r) => r.code === code));
  }, `CTC to record ${code} on ${head.slice(0, 7)}`, QUEUE_MS);

/** What CTC says of `number` now, the job's decision without recording it. */
export const nowSaid = (kit, repo, number, want, what) =>
  settled(async () => {
    const said = (await gates(kit, repo, number)).land_when_cleared;
    return want(said) && said;
  }, what, QUEUE_MS);

export const reasonCodes = (said) => said.reasons.map((r) => r.code);

/** Whether `read` still holds once a job would have run: nothing landed behind our back. */
export async function staysOpen(kit, repo, number, why) {
  await new Promise((done) => setTimeout(done, SETTLE_MS));
  assert.equal((await change(kit, repo, number)).status, 'open', why);
}

/** How many first-parent commits of `ref`'s history are `commit`, in a fresh clone. */
export async function onMainTimes(kit, dir, commit) {
  await kit.ok('git', ['fetch', '-q', 'origin'], { cwd: dir, env: kit.env(NO_SESSION) });
  const log = await kit.gitOk(dir, 'log', '--first-parent', '--format=%H', 'origin/main');
  return log.split('\n').filter((id) => id === commit).length;
}
