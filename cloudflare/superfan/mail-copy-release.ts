// The words of the alerts about a release and the synthetic checks, in the mail's worst-first order
// inside COPY (mail-copy.ts).
import { type Copy, capital, count, duration, type Facts, percent } from './mail-words';

/** What a synthetic check saw; two tries in each of two passes stand behind it. */
const probeFailed = (name: string) => (f: Facts) => {
  const status = f.values[name];
  return typeof status === 'number'
    ? `It failed two passes in a row, last with HTTP ${status}.`
    : 'It failed two passes in a row with no answer.';
};
const PROBE_FIRST = 'Read GET /probes for the request id. If a deploy is new, roll back.';

export const PROBE_COPY: Copy[] = [
  {
    signals: ['probe_health'],
    title: () => 'Website health check failing from outside',
    means: probeFailed('probe_health'),
    first: PROBE_FIRST,
    link: () => ({ label: 'Check it yourself', path: '/health' }),
  },
  {
    signals: ['probe_page'],
    title: () => 'Home page failing from outside',
    means: probeFailed('probe_page'),
    first: PROBE_FIRST,
  },
  {
    signals: ['probe_api'],
    title: () => 'API reads failing from outside',
    means: probeFailed('probe_api'),
    first: PROBE_FIRST,
  },
  {
    signals: ['probe_clone'],
    title: () => 'Public clone failing from outside',
    means: probeFailed('probe_clone'),
    first: PROBE_FIRST,
  },
  {
    signals: ['probe_land'],
    title: () => 'Test landing failing on dev',
    means: probeFailed('probe_land'),
    first: PROBE_FIRST,
  },
];

export const RELEASE_COPY: Copy[] = [
  {
    signals: ['release_error_rate'],
    title: (f) => `${capital(f.word)} calls fail more since the deploy`,
    means: (f) => {
      const now = percent(count(f, 'release_error_rate'));
      return f.baseline === undefined
        ? `${now} of calls fail.`
        : `${now} of calls fail, against ${percent(f.baseline)} before it.`;
    },
    first: 'Read the new release in GET /deploys. Roll back if it is the cause.',
  },
  {
    signals: ['release_p95_ms'],
    title: (f) => `${capital(f.word)} calls are slower since the deploy`,
    means: (f) => {
      const now = duration(count(f, 'release_p95_ms'));
      return f.baseline === undefined
        ? `The slowest calls take ${now}.`
        : `The slowest calls take ${now}, against ${duration(f.baseline)} before it.`;
    },
    first: 'Compare the two releases in GET /deploys. Check for a burst first.',
  },
];
