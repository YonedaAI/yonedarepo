// The words of an alert mail: what each signal means to a person and what to do first, condensed
// from docs/incidents.md. Each entry is one cause, so signals of one cause on one component become
// one block (mail-render.ts). In order, worst first: the first item names the mail. Every signal
// the watcher can raise needs a line here; a test holds that, and these lines to the UI rules.

export interface Facts {
  /** Fired signals of this cause, by name. */
  values: Record<string, number | null>;
  /** The component's word (`repository`). */
  word: string;
  /** What its queue holds (`background job`). */
  noun: string;
  /** The usual p95, for a latency signal. */
  baseline?: number;
}
export interface Link {
  label: string;
  /** Under the site, or the API when `api` is set. */
  path: string;
  api?: boolean;
}
export interface Copy {
  signals: string[];
  title(f: Facts): string;
  means: string | ((f: Facts) => string);
  first: string;
  /** A different first step on these components. */
  firstOn?: Record<string, string>;
  /** The finding's own reason says more than these words: show it. */
  reason?: boolean;
  link?: (component: string) => Link;
}

/** Component keys in the reader's words. They also rewrite the model's guess. */
export const WORD: Record<string, string> = {
  api_worker: 'API',
  front_worker: 'website',
  managed_worker: 'managed agent',
  source_repository: 'repository',
  object_push_queue: 'Git push',
  check_runs: 'check',
  derived_jobs: 'background job',
  land_queue: 'landing',
  commit_shards: 'commit',
  pack_builder: 'clone pack',
  ssh_gateway: 'SSH',
  workspace_authority: 'account',
  cron: 'scheduled task',
};
const NOUN: Record<string, string> = {
  derived_jobs: 'background job',
  check_runs: 'check run',
  managed_worker: 'managed agent run',
};
export const nounOf = (component: string) => NOUN[component] ?? WORD[component] ?? 'item';

export const number = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const count = (f: Facts, ...names: string[]) => {
  for (const name of names) if (typeof f.values[name] === 'number') return f.values[name];
  return 0;
};
export const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const duration = (ms: number) =>
  ms < 1_000
    ? `${number(ms)} ms`
    : ms < 90_000
      ? `${(ms / 1_000).toFixed(1)} s`
      : `${number(Math.round(ms / 60_000))} minutes`;

/** The counts behind a failure rate; with no rate, they already are the title. */
function errorCounts(f: Facts) {
  if (typeof f.values.error_rate !== 'number') return 'Unhandled errors in the last hour.';
  const parts = [
    typeof f.values.exceptions === 'number' ? plural(f.values.exceptions, 'exception') : null,
    typeof f.values.error_logs === 'number' ? plural(f.values.error_logs, 'error line') : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} this hour.` : 'More calls than usual are failing.';
}

const healthLink = (component: string): Link => ({
  label: 'Check it yourself',
  path: '/health',
  api: component !== 'front_worker',
});
const admin = (path: string, label: string) => () => ({ label, path });

export const COPY: Copy[] = [
  {
    signals: ['health'],
    title: (f) => `${capital(f.word)} health check failing`,
    means: (f) => {
      const status = f.values.health;
      if (status === null || status === undefined) return 'It did not answer.';
      return status === 200 ? 'It answered, but not as itself.' : `It answered HTTP ${status}.`;
    },
    first: 'Open it yourself. If it is down and a deploy is new, roll back.',
    link: healthLink,
  },
  {
    signals: ['reconcile_mismatches'],
    title: (f) =>
      `${plural(count(f, 'reconcile_mismatches'), 'billing mismatch', 'billing mismatches')} with Stripe`,
    means: 'Stripe and our billing records disagree. The check changed nothing.',
    first: "Find billing.reconcile.mismatch in the managed logs. Don't refund yet.",
    link: admin('/admin', 'Open admin'),
  },
  {
    signals: ['storage_full'],
    title: () => 'Repository history reached its limit',
    means: 'New commits and Landings stop at 9.4 GB. Reads and deletes still work.',
    first: 'Find the repository on the admin page, then vacuum or split it.',
    link: admin('/admin/repos', 'Open repositories'),
  },
  {
    signals: ['storage_9gb'],
    title: (f) => {
      const n = count(f, 'storage_9gb');
      return n === 1 ? 'Repository past 9 GB' : `${number(n)} repositories past 9 GB`;
    },
    means: 'New commits and Landings stop at 9.4 GB.',
    first: 'Find the repository on the admin page, then vacuum or split it.',
    link: admin('/admin/repos', 'Open repositories'),
  },
  {
    signals: ['dead_lettered', 'dead_letter_backlog'],
    title: (f) => `${plural(count(f, 'dead_lettered', 'dead_letter_backlog'), f.noun)} failed`,
    means: (f) => {
      const waiting = f.values.dead_letter_backlog;
      const held =
        typeof waiting === 'number' ? ` ${number(waiting)} are waiting for a retry by hand.` : '';
      return `Nothing retries them, and they expire.${held}`;
    },
    first: 'Find job.failed in the platform logs, fix it, then requeue by hand.',
    firstOn: {
      managed_worker: 'Find managed.queue in the managed logs, fix it, then requeue by hand.',
    },
  },
  {
    signals: ['cron_missing'],
    title: () => 'Scheduled tasks have stopped',
    means: 'Purges, compaction, SSH keep-alive and the nightly billing check are off.',
    first: "Check the platform Worker's Cron Triggers, then redeploy it.",
  },
  {
    signals: ['error_rate', 'exceptions', 'error_logs'],
    title: (f) => {
      const rate = f.values.error_rate;
      if (typeof rate === 'number')
        return `${Number((rate * 100).toFixed(1))}% of ${f.word} calls failing`;
      return `${number(count(f, 'exceptions', 'error_logs'))} ${f.word} errors`;
    },
    means: errorCounts,
    first: "Open this Worker's logs. If a deploy started it, roll back.",
  },
  {
    signals: ['resource_kills'],
    title: (f) =>
      `${plural(count(f, 'resource_kills'), `${f.word} call`)} killed for CPU or memory`,
    means: 'A large repository or job needs a bound.',
    first: 'Find exceededCpu or exceededMemory in the logs, then the repository.',
  },
  {
    signals: ['storage_8gb'],
    title: (f) => {
      const n = count(f, 'storage_8gb');
      return n === 1 ? 'Repository past 8 GB' : `${number(n)} repositories past 8 GB`;
    },
    means: 'New commits and Landings stop at 9.4 GB, so there is time to plan.',
    first: 'Find the repository on the admin page and plan compaction or a split.',
    link: admin('/admin/repos', 'Open repositories'),
  },
  {
    signals: ['compaction_stalls'],
    title: () => 'Repository log compaction stalled',
    means: 'A hold is stopping a repository log from shrinking.',
    first: 'Find compaction.stalled in the platform logs. Its repo says which.',
  },
  {
    signals: ['land_failures'],
    title: (f) => `${plural(count(f, 'land_failures'), 'landing batch', 'landing batches')} failed`,
    means: 'Lost races are not counted, so these are real failures.',
    first: 'Find land.batch_failed in the platform logs: repo and error.',
  },
  {
    signals: ['failed_crons'],
    title: (f) => plural(count(f, 'failed_crons'), 'scheduled task failure'),
    means: 'Each task runs alone, so the others kept running.',
    first: 'Find *.sweep_failed or ssh.keepalive_failed in the platform logs.',
  },
  {
    signals: ['backlog', 'backlog_growth'],
    title: (f) => `${plural(count(f, 'backlog', 'backlog_growth'), f.noun)} waiting`,
    means: 'The queue is growing faster than it drains.',
    first: 'Check the consumer in its logs. A stuck or slow job is the usual cause.',
  },
  {
    signals: ['land_timeouts'],
    title: (f) => `${plural(count(f, 'land_timeouts'), 'landing')} waited over 20 seconds`,
    means: 'Landers retry for up to 2 minutes, then give up.',
    first: 'Find land.timed_out in the logs. A big burst on dev explains this.',
  },
  {
    signals: ['lag_ms'],
    title: (f) => `${capital(f.noun)}s waited ${duration(count(f, 'lag_ms'))} to start`,
    means: 'Work is queueing longer than it should.',
    first: 'Find job.failed in the platform logs. A slow job is the usual cause.',
  },
  {
    signals: ['retries_per_message'],
    title: (f) => `${capital(f.noun)}s keep retrying`,
    means: (f) => `${number(count(f, 'retries_per_message'))} retries each on average.`,
    first: 'Find job.failed in the platform logs.',
  },
  {
    signals: ['push_retries'],
    title: (f) =>
      `${plural(count(f, 'push_retries'), 'Git push', 'Git pushes')} refused and retried`,
    means: 'The object store is busy. This usually clears itself.',
    first: 'If it keeps going, find object store push attempts in the platform logs.',
  },
  {
    signals: ['container_disk_percent'],
    title: (f) => `Check containers at ${number(count(f, 'container_disk_percent'))}% disk`,
    means: 'Checks can fail once the disk fills.',
    first: 'Look at the check image and workspace sizes.',
  },
  {
    signals: ['p95_wall_ms'],
    title: (f) => `${capital(f.word)} calls slowed to ${duration(count(f, 'p95_wall_ms'))}`,
    means: (f) =>
      f.baseline ? `They usually take about ${duration(f.baseline)}.` : 'Slower than usual.',
    first: 'Find the slowest operations in the logs. A burst on dev explains most.',
  },
  {
    signals: ['deadman_stale'],
    title: () => 'Dead-man check has stopped',
    means: 'If the monitor stops now, nobody is told.',
    first: "Check the dead-man Worker's Cron Triggers, then redeploy it.",
  },
];

/** A signal this list has not met yet: plain words, never its raw name. */
export const UNKNOWN: Copy = {
  signals: [],
  title: () => 'Something needs a look',
  means: 'This alert has no write-up yet.',
  first: 'Read the incident guide, then the logs.',
};

const BLIND = 'Queue and dead letter alerts cannot fire until this is back.';
/** Monitoring's own faults (`telemetry:<reason>`); they rank just above a Worker's errors. */
export const TELEMETRY_COPY: Record<string, Copy> = {
  tail_silent: {
    signals: ['tail_silent'],
    title: () => 'Monitoring has stopped receiving events',
    means: 'Alerts built on logs and errors cannot fire until this is back.',
    first: 'Check the Worker still names the monitor as a tail consumer. Redeploy.',
  },
  fetch_failed: {
    signals: ['fetch_failed'],
    title: () => 'Monitoring cannot read Cloudflare analytics',
    means: BLIND,
    reason: true,
    first: 'Check the analytics token, then the reason above.',
  },
  config: {
    signals: ['config'],
    title: () => 'Monitoring is misconfigured',
    means: 'Most alerts cannot fire until this is fixed.',
    reason: true,
    first: 'Fix the setting named above, then deploy the monitor.',
  },
  token_missing: {
    signals: ['token_missing'],
    title: () => 'Monitoring is missing its analytics token',
    means: BLIND,
    first: 'Set CF_ANALYTICS_TOKEN on the monitor.',
  },
  disabled: {
    signals: ['disabled'],
    title: () => 'Monitoring has analytics turned off',
    means: BLIND,
    first: 'Set TELEMETRY_SOURCE to cloudflare on the monitor.',
  },
};
