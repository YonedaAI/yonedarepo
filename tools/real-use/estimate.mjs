// What a run sends, from the scripts themselves: each is played many times against a stub that
// answers everything, so a request count here can't drift from what the code does.
import { dayShare, DEFAULTS, MIX, randomStream, ZONES } from './plan.mjs';
import { SCRIPTS } from './sessions.mjs';

const PLAYS = 400;

function stubActor(random, tally) {
  const reply = (s) => ({ ok: true, value: s.keep ? { refs: { 'refs/heads/main': 'a'.repeat(40) }, commit: 'b'.repeat(40), head: 'c'.repeat(40), changes: [{ number: 1, status: 'open' }] } : undefined });
  const one = async (s) => {
    tally.requests++;
    tally.labels[s.label] = (tally.labels[s.label] ?? 0) + 1;
    return reply(s);
  };
  return {
    random,
    assets: ['/assets/a.js', '/assets/a.css'],
    api: '/api/v1/repos/r',
    credential: 'token',
    repo: { id: `r${'0'.repeat(20)}`, paths: ['f00.txt'], blobs: {}, seed_commit: 'd'.repeat(40) },
    step: one,
    steps: async (steps) => Promise.all(steps.map(one)),
    page: async (steps) => Promise.all(steps.map(one)),
    think: async (low, high) => {
      tally.think += (low + high) / 2;
    },
  };
}

/** Requests, think seconds and steps by label, per session of each kind. */
export async function perSession() {
  const out = {};
  for (const [kind, script] of Object.entries(SCRIPTS)) {
    const tally = { requests: 0, think: 0, labels: {} };
    const random = randomStream(7);
    for (let i = 0; i < PLAYS; i++) await script(stubActor(random, tally));
    out[kind] = { requests: tally.requests / PLAYS, seconds: tally.think / PLAYS, labels: Object.fromEntries(Object.entries(tally.labels).map(([k, v]) => [k, v / PLAYS])) };
  }
  return out;
}

/** The run a plan describes: rates, requests and how they divide. */
export async function estimateRun(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const kinds = await perSession();
  const sharedBy = (read) => Object.entries(MIX).reduce((n, [kind, m]) => n + m.share * read(kinds[kind]), 0);
  const meanSeconds = sharedBy((k) => k.seconds);
  const peakPerMinute = o.peakSessions / (meanSeconds / 60);
  const meanRequests = sharedBy((k) => k.requests);
  const sessions = peakPerMinute * dayShare() * o.minutes;
  const peakRequestsPerSecond = (peakPerMinute * meanRequests) / 60;
  return { ...o, kinds, meanSeconds, meanRequests, peakPerMinute, sessions, requests: sessions * meanRequests, peakRequestsPerSecond, dayShare: dayShare(), zones: ZONES };
}

const round = (n, places = 0) => Number(n.toFixed(places));

export function describeRun(e) {
  const lines = [
    `Real use: ${e.minutes} minutes for one day, ${e.accounts} accounts, ${e.accounts * e.reposPerAccount} repositories, ${e.peakSessions} sessions at once at the peak.`,
    `Sessions: ${round(e.peakPerMinute, 1)} a minute at the peak, about ${round(e.sessions)} in the run. Requests: ${round(e.peakRequestsPerSecond, 1)}/s at the peak, about ${round(e.requests)} in the run, plus real Git every ${e.gitEvery} s and the sampler.`,
    '| Session | Share | Who | Requests | Think, s |',
    '|---|---|---|---|---|',
    ...Object.entries(MIX).map(([kind, m]) => `| ${kind} | ${round(m.share * 100)}% | ${m.who} | ${round(e.kinds[kind].requests, 1)} | ${round(e.kinds[kind].seconds)} |`),
    'Cost basis: Workers, Durable Object, R2 and D1 requests at list price, about $0.60 per million platform requests; no container and no model. Re-check before raising --peak-sessions.',
  ];
  return lines.join('\n');
}
