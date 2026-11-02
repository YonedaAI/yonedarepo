// The real-use simulation's assumptions, in one place and all of them guesses: there is no real
// traffic yet (docs/load-testing.md, Real-use simulation). A day of people and agents is played
// in the run's length, so the day's rhythm is compressed but each session's pace is real.

/** Where sessions come from. `utc` is the offset that sets each region's working day. */
export const ZONES = {
  na: { share: 0.45, utc: -5 },
  eu: { share: 0.35, utc: 1 },
  ap: { share: 0.2, utc: 8 },
};

/** What a session is, by who runs it, as shares of all sessions. */
export const MIX = {
  browse: { who: 'person', share: 0.28 },
  review: { who: 'person', share: 0.1 },
  search: { who: 'person', share: 0.07 },
  agent: { who: 'agent', share: 0.3 },
  mcp: { who: 'agent', share: 0.15 },
  git: { who: 'agent', share: 0.1 },
};

/** A person's activity over local hours 0 to 23: 1 is the busiest hour. */
const PEOPLE = [0.03, 0.02, 0.02, 0.02, 0.02, 0.03, 0.08, 0.2, 0.5, 0.85, 1, 0.95, 0.6, 0.8, 1, 1, 0.9, 0.7, 0.4, 0.25, 0.2, 0.15, 0.1, 0.05];
/** Agents follow the people who start them, an hour on, and some run all night. */
const AGENT_FLOOR = 0.3;

const at = (curve, hour) => {
  const h = ((hour % 24) + 24) % 24;
  const low = Math.floor(h);
  return curve[low] + (curve[(low + 1) % 24] - curve[low]) * (h - low);
};

/** How busy `who` is at local `hour`, 0 to 1. */
export const activity = (who, hour) => (who === 'agent' ? Math.max(AGENT_FLOOR, at(PEOPLE, hour - 1)) : at(PEOPLE, hour));

/** The simulated UTC hour `minute` of a run reaches, one day over the run. */
export const simHour = (minute, minutes, startUtc = 0) => (startUtc + (24 * minute) / minutes) % 24;

/** The data region each client region's accounts live in, on the `region` arm. */
export const homeOf = { na: 'enam', eu: 'weur', ap: 'apac' };

const load = (kind, region, hour) => MIX[kind].share * ZONES[region].share * activity(MIX[kind].who, hour + ZONES[region].utc);
const total = (hour) => Object.keys(MIX).reduce((sum, kind) => sum + Object.keys(ZONES).reduce((n, region) => n + load(kind, region, hour), 0), 0);

/** The busiest moment of the day, so `peakPerMinute` means what it says. */
export const peakLoad = () => {
  let peak = 0;
  for (let h = 0; h < 24; h += 0.25) peak = Math.max(peak, total(h));
  return peak;
};
export const dayShare = () => {
  let sum = 0;
  for (let h = 0; h < 24; h += 0.25) sum += total(h);
  return sum / 96 / peakLoad();
};

/** Sessions of `kind` per minute starting in `region` at UTC `hour`. */
export const ratePerMinute = (kind, region, hour, peakPerMinute) => (peakPerMinute * load(kind, region, hour)) / peakLoad();

/** Numbers from one stream, repeatable by `seed`: a run can be played again. */
export function randomStream(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A popular repository is opened far more than the rest (Zipf, s = 1). */
export function zipfIndex(random, size) {
  const weights = Array.from({ length: size }, (_, i) => 1 / (i + 1));
  let left = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < size; i++) if ((left -= weights[i]) <= 0) return i;
  return size - 1;
}

/** `region`: each region's accounts and repositories live there, and are served there. `today`:
 * everything in enam behind the pinned Worker, as now. Same requests, same seed. */
export const ARMS = ['region', 'today'];

export const DEFAULTS = { arm: 'region', minutes: 60, peakSessions: 150, accounts: 24, reposPerAccount: 3, files: 60, seed: 1, gitEvery: 120, sampleSeconds: 120, startUtc: 0 };
