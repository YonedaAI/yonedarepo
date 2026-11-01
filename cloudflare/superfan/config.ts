// Superfan configuration. WATCH_SCRIPT is an environment's platform-only Worker; a config that
// names any other script is refused, not watched. Tail events are read from that Worker and, on
// the wide watch, from its environment's front and managed Workers; any other script's are dropped.
import type { SuperfanLedger } from './ledger';

/** The scripts this watcher may read: the dev and production platform Workers. */
const WATCHABLE = new Set(['yonedarepo-dev-platform', 'yonedarepo-prod-platform']);
export const isWatchable = (script: string) => WATCHABLE.has(script);
/** The wide watch: every Worker, cron and queue of the environment, urgent alerts and quick
 * passes. Off, the watcher behaves as before these existed (prod, until the owner turns it on). */
export const wideOn = (env: SuperfanEnv) => env.WATCH_WIDE === 'on';
/** The synthetic checks (synthetic.ts). Off, they spend nothing. */
export const probesOn = (env: SuperfanEnv) => env.PROBES === 'on';
/** The hard ceiling on model spend per UTC day, whatever the configuration says ($1.00). */
export const HARD_DAILY_CAP_MICROUSD = 1_000_000;

export interface SuperfanEnv {
  LEDGER: DurableObjectNamespace<SuperfanLedger>;
  CF_ACCOUNT_ID: string;
  WATCH_SCRIPT: string;
  WATCH_URL: string;
  /** `on`: the wide watch (`wideOn`). */
  WATCH_WIDE?: string;
  /** The site as people reach it: what the wide watch and the synthetic checks probe. */
  WATCH_FRONT_URL?: string;
  /** `on`: synthetic checks every five minutes. */
  PROBES?: string;
  /** `on`: dead requests and synthetic results go to SITE_EVENTS (service-points.ts). */
  SERVICE_LEVELS?: string;
  SITE_EVENTS?: AnalyticsEngineDataset;
  /** `on`, on dev alone: the checks also land on PROBE_LAND_REPO. */
  PROBE_LANDING?: string;
  /** Worker secret: a small public repository for the clone check; unset: no clone check. */
  PROBE_CLONE_REPO?: string;
  /** Worker secrets: the repository the landing check writes to, and a token limited to it. */
  PROBE_LAND_REPO?: string;
  PROBE_LAND_TOKEN?: string;
  /** `on`: each full pass compares this release with the one before (release.ts). */
  RELEASE_COMPARE?: string;
  /** The dead-man Worker (deadman.ts), watched back; unset: not watched. */
  DEADMAN_URL?: string;
  /** The watched resources' ids. All unset: looked up by name at run time (resolveIds). */
  NS_SOURCE_REPOSITORY?: string;
  NS_OBJECT_PUSH_QUEUE?: string;
  NS_CHECK_CONTAINER?: string;
  QUEUE_JOBS_ID?: string;
  QUEUE_DEAD_LETTER_ID?: string;
  CHECK_CONTAINER_APP_ID?: string;
  /** Read only on the wide watch. */
  QUEUE_CHECKS_ID?: string;
  QUEUE_MANAGED_RUNS_ID?: string;
  QUEUE_MANAGED_DEAD_LETTER_ID?: string;
  /** `cloudflare` also reads the GraphQL Analytics API; `disabled` uses tail events only. */
  TELEMETRY_SOURCE: string;
  SUPERFAN_MODEL: string;
  MIMO_TOKEN_PLAN_REGION?: string;
  DAILY_CAP_MICROUSD?: string;
  /** Worker secret: an API token with Account Analytics Read, plus Workers Scripts Read,
   * Queues Read and Containers Read when the ids are looked up by name. */
  CF_ANALYTICS_TOKEN?: string;
  /** Worker secret: bearer for the findings read endpoint. */
  SUPERFAN_READ_TOKEN?: string;
  MIMO_KEY?: SecretsStoreSecret;
  ZAI_KEY?: SecretsStoreSecret;
  /** Where new findings are mailed (notify.ts); empty: no mail. */
  ADMIN_NOTIFY_EMAIL?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: SecretsStoreSecret;
}

export interface WatchIds {
  namespaces: { source_repository: string; object_push_queue: string; check_runs: string };
  queues: {
    jobs: string;
    deadLetter: string;
    /** On the wide watch. */
    checks?: string;
    managedRuns?: string;
    managedDeadLetter?: string;
  };
  checkApp: string;
}
export interface WatchSite {
  account: string;
  script: string;
  healthUrl: string;
  /** The front Worker's health URL; null unless the wide watch or the checks need it. */
  frontHealthUrl: string | null;
  deadmanHealthUrl: string | null;
  wide: boolean;
  /** `null`: no id is configured; they are looked up by name when analytics run. */
  ids: WatchIds | null;
}
export type WatchTarget = Omit<WatchSite, 'ids'> & WatchIds;

const ID_VARS = [
  'NS_SOURCE_REPOSITORY',
  'NS_OBJECT_PUSH_QUEUE',
  'NS_CHECK_CONTAINER',
  'QUEUE_JOBS_ID',
  'QUEUE_DEAD_LETTER_ID',
  'CHECK_CONTAINER_APP_ID',
] as const;

const hex32 = /^[0-9a-f]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function id(name: string, value: string | undefined, pattern: RegExp) {
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or malformed`);
  return value;
}

function httpsUrl(name: string, value: string | undefined) {
  if (!URL.canParse(value ?? '') || new URL(value as string).protocol !== 'https:')
    throw new Error(`${name} must be an HTTPS URL`);
  return value as string;
}

/** Validates the watch target; throws a configuration error that names the bad variable. Ids
 * are all configured or all looked up: a partial set is an error. */
export function watchSite(env: SuperfanEnv): WatchSite {
  if (!WATCHABLE.has(env.WATCH_SCRIPT))
    throw new Error('WATCH_SCRIPT must name the isolated platform-only Worker');
  const url = new URL(env.WATCH_URL);
  if (url.protocol !== 'https:' || !url.hostname.startsWith(`${env.WATCH_SCRIPT}.`))
    throw new Error('WATCH_URL must be the watched Worker over HTTPS');
  const wide = wideOn(env);
  const front = wide || probesOn(env) ? httpsUrl('WATCH_FRONT_URL', env.WATCH_FRONT_URL) : null;
  const deadman = wide && env.DEADMAN_URL ? httpsUrl('DEADMAN_URL', env.DEADMAN_URL) : null;
  const site = {
    account: id('CF_ACCOUNT_ID', env.CF_ACCOUNT_ID, hex32),
    script: env.WATCH_SCRIPT,
    healthUrl: new URL('/health', url).toString(),
    frontHealthUrl: front && new URL('/health', front).toString(),
    deadmanHealthUrl: deadman && new URL('/health', deadman).toString(),
    wide,
  };
  if (ID_VARS.every((name) => !env[name])) return { ...site, ids: null };
  const ids: WatchIds = {
    namespaces: {
      source_repository: id('NS_SOURCE_REPOSITORY', env.NS_SOURCE_REPOSITORY, hex32),
      object_push_queue: id('NS_OBJECT_PUSH_QUEUE', env.NS_OBJECT_PUSH_QUEUE, hex32),
      check_runs: id('NS_CHECK_CONTAINER', env.NS_CHECK_CONTAINER, hex32),
    },
    queues: {
      jobs: id('QUEUE_JOBS_ID', env.QUEUE_JOBS_ID, hex32),
      deadLetter: id('QUEUE_DEAD_LETTER_ID', env.QUEUE_DEAD_LETTER_ID, hex32),
      ...(wide
        ? {
            checks: id('QUEUE_CHECKS_ID', env.QUEUE_CHECKS_ID, hex32),
            managedRuns: id('QUEUE_MANAGED_RUNS_ID', env.QUEUE_MANAGED_RUNS_ID, hex32),
            managedDeadLetter: id(
              'QUEUE_MANAGED_DEAD_LETTER_ID',
              env.QUEUE_MANAGED_DEAD_LETTER_ID,
              hex32,
            ),
          }
        : {}),
    },
    checkApp: id('CHECK_CONTAINER_APP_ID', env.CHECK_CONTAINER_APP_ID, uuid),
  };
  return { ...site, ids };
}

/** The configured daily cap, never above the hard ceiling. */
export function dailyCap(env: SuperfanEnv) {
  const configured = Number(env.DAILY_CAP_MICROUSD ?? HARD_DAILY_CAP_MICROUSD);
  if (!Number.isSafeInteger(configured) || configured < 0) return 0;
  return Math.min(configured, HARD_DAILY_CAP_MICROUSD);
}
