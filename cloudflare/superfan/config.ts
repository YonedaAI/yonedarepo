// Superfan configuration. The watcher reads only an environment's platform-only Worker; a
// config that names any other script (an agent Worker included) is refused, not watched, and
// tail events from any other script are dropped.
import type { SuperfanLedger } from './ledger';

/** The scripts this watcher may read: the dev and production platform Workers. */
const WATCHABLE = new Set(['yonedarepo-dev-platform', 'yonedarepo-prod-platform']);
export const isWatchable = (script: string) => WATCHABLE.has(script);
/** The hard ceiling on model spend per UTC day, whatever the configuration says ($1.00). */
export const HARD_DAILY_CAP_MICROUSD = 1_000_000;

export interface SuperfanEnv {
  LEDGER: DurableObjectNamespace<SuperfanLedger>;
  CF_ACCOUNT_ID: string;
  WATCH_SCRIPT: string;
  WATCH_URL: string;
  /** The watched resources' ids. All unset: looked up by name at run time (resolveIds). */
  NS_SOURCE_REPOSITORY?: string;
  NS_OBJECT_PUSH_QUEUE?: string;
  NS_CHECK_CONTAINER?: string;
  QUEUE_JOBS_ID?: string;
  QUEUE_DEAD_LETTER_ID?: string;
  CHECK_CONTAINER_APP_ID?: string;
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
}

export interface WatchIds {
  namespaces: { source_repository: string; object_push_queue: string; check_runs: string };
  queues: { jobs: string; deadLetter: string };
  checkApp: string;
}
export interface WatchSite {
  account: string;
  script: string;
  healthUrl: string;
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

/** Validates the watch target; throws a configuration error that names the bad variable. Ids
 * are all configured or all looked up: a partial set is an error. */
export function watchSite(env: SuperfanEnv): WatchSite {
  if (!WATCHABLE.has(env.WATCH_SCRIPT))
    throw new Error('WATCH_SCRIPT must name the isolated platform-only Worker');
  const url = new URL(env.WATCH_URL);
  if (url.protocol !== 'https:' || !url.hostname.startsWith(`${env.WATCH_SCRIPT}.`))
    throw new Error('WATCH_URL must be the watched Worker over HTTPS');
  const site = {
    account: id('CF_ACCOUNT_ID', env.CF_ACCOUNT_ID, hex32),
    script: env.WATCH_SCRIPT,
    healthUrl: new URL('/health', url).toString(),
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
