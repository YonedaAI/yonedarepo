// Runs stage 6's plan (distance-plan.mjs): bursts through a client placed in each region, on one
// session per client, then the limiters. Dev only, like every bench. A burst that breaks the stop
// rules ends that client's larger sizes, not the other clients'.
import { burst } from './burst.mjs';
import { b64 } from './driver.mjs';
import { burstStops, LIMIT_RESET_MS, tally } from './distance-plan.mjs';

const WIDTH = 6;
const LANES = 8;
/** Nobody has this name: a refused sign-in changes nothing on any account. */
export const NOBODY = { username: 'limit-probe-nobody', password: 'not-a-real-password-0' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** `steps` from one client, six at a time in eight lanes; a call that fails counts its steps. */
export async function flood(call, client, steps) {
  const batches = [];
  for (let at = 0; at < steps.length; at += WIDTH) batches.push(steps.slice(at, at + WIDTH));
  const rows = [];
  const lane = async () => {
    for (let batch = batches.shift(); batch; batch = batches.shift()) {
      const answer = await call(client, { steps: batch, parallel: true });
      rows.push(...(answer.failed ? batch.map(() => ({ status: 0, error: 'CLIENT', message: answer.failed })) : answer.results));
    }
  };
  await Promise.all(Array.from({ length: LANES }, lane));
  return rows;
}

const publicRead = (repo) => ({ label: 'public', path: `/api/v1/repos/${repo}/refs` });
const signIn = { label: 'signin', path: '/api/auth/login', json: NOBODY };
const copies = (step, count) => Array.from({ length: count }, () => step);

/** One region's round: past both limits from one address. */
export async function limitsRound(call, client, repo, o) {
  const [reads, signIns] = await Promise.all([flood(call, client, copies(publicRead(repo), o.publicReads)), flood(call, client, copies(signIn, o.signIns))]);
  return { public: tally(reads), auth: tally(signIns) };
}

/** Two regions at once, each under the limit and together over it: one counter refuses and a
 * counter per location doesn't. Today both clients reach the same pinned Worker. */
export async function limitsBoth(call, repo, o) {
  const [eu, ap] = await Promise.all(['eu', 'ap'].map((client) => flood(call, client, copies(publicRead(repo), o.bothReads))));
  return { eu: tally(eu), ap: tally(ap), both: tally([...eu, ...ap]) };
}

/** Runs `items`; `sessions[client]` is a bench session through that client. Every result goes to
 * `record` as it comes. `limitRepo` is a public test repository, made for the limiter rounds. */
export async function runDistance({ sessions, call, limitRepo, items, options, record, log = console.error, wait = pause, now = Date.now }) {
  const stopped = {};
  const done = [];
  let countersFull = -Infinity;
  for (const item of items) {
    const name = `${item.kind}-${item.client.replace('+', '-')}${item.writers ? `-${item.writers}` : ''}-run${item.run}`;
    if (stopped[item.client]) {
      log(`${name}: skipped, ${item.client} stopped: ${stopped[item.client]}`);
      continue;
    }
    log(`${name}: running`);
    if (item.kind === 'burst') {
      const session = sessions[item.client];
      const result = await burst(session, { writers: item.writers, principals: 'tokens' });
      const left = await session.cleanup();
      const stops = burstStops(result);
      await record(name, { ...item, ...result, stops, left });
      if (stops.length) stopped[item.client] = `${item.writers} writers: ${stops.join(', ')}`;
    } else {
      // Every round starts on emptied counters: all clients share one address.
      await wait(Math.max(0, countersFull + LIMIT_RESET_MS - now()));
      const result = item.kind === 'limits' ? await limitsRound(call, item.client, limitRepo, options) : await limitsBoth(call, limitRepo, options);
      countersFull = now();
      await record(name, { ...item, ...result });
    }
    done.push(item);
  }
  return { done, stopped };
}

/** A public repository for the limiter rounds; its session deletes it with `cleanup`. */
export const limitRepository = (session) => session.createRepo('limit-probe', [{ path: 'README.md', content_b64: b64('limit probe\n') }], { visibility: 'public' });
