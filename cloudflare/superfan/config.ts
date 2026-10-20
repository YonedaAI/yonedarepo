// Superfan configuration. The watcher reads only the isolated platform-only Worker; a config
// that names any other script (production yonedarepo-dev included) is refused, not watched,
// and tail events from any other script are dropped.
import type { SuperfanLedger } from './ledger';

/** The scripts this watcher may read. Production is deliberately absent. */
const WATCHABLE = new Set(['yonedarepo-platform-dev']);
export const isWatchable = (script: string) => WATCHABLE.has(script);
/** The hard ceiling on model spend per UTC day, whatever the configuration says ($1.00). */
export const HARD_DAILY_CAP_MICROUSD = 1_000_000;

export interface SuperfanEnv {
  LEDGER: DurableObjectNamespace<SuperfanLedger>;
  CF_ACCOUNT_ID: string;
  WATCH_SCRIPT: string;
  WATCH_URL: string;
  NS_SOURCE_REPOSITORY: string;
  NS_OBJECT_PUSH_QUEUE: string;
  NS_CHECK_CONTAINER: string;
  QUEUE_JOBS_ID: string;
  QUEUE_DEAD_LETTER_ID: string;
  CHECK_CONTAINER_APP_ID: string;
  /** `cloudflare` also reads the GraphQL Analytics API; `disabled` uses tail events only. */
  TELEMETRY_SOURCE: string;
  SUPERFAN_MODEL: string;
  MIMO_TOKEN_PLAN_REGION?: string;
  DAILY_CAP_MICROUSD?: string;
  /** Worker secret: an API token with Account Analytics Read only. */
  CF_ANALYTICS_TOKEN?: string;
  /** Worker secret: bearer for the findings read endpoint. */
  SUPERFAN_READ_TOKEN?: string;
  MIMO_KEY?: SecretsStoreSecret;
  ZAI_KEY?: SecretsStoreSecret;
}

export interface WatchTarget {
  account: string;
  script: string;
  healthUrl: string;
  namespaces: { source_repository: string; object_push_queue: string; check_runs: string };
  queues: { jobs: string; deadLetter: string };
  checkApp: string;
}

const hex32 = /^[0-9a-f]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function id(name: string, value: string | undefined, pattern: RegExp) {
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or malformed`);
  return value;
}

/** Validates the watch target; throws a configuration error that names the bad variable. */
export function watchTarget(env: SuperfanEnv): WatchTarget {
  if (!WATCHABLE.has(env.WATCH_SCRIPT))
    throw new Error('WATCH_SCRIPT must name the isolated platform-only Worker');
  const url = new URL(env.WATCH_URL);
  if (url.protocol !== 'https:' || !url.hostname.startsWith(`${env.WATCH_SCRIPT}.`))
    throw new Error('WATCH_URL must be the watched Worker over HTTPS');
  return {
    account: id('CF_ACCOUNT_ID', env.CF_ACCOUNT_ID, hex32),
    script: env.WATCH_SCRIPT,
    healthUrl: new URL('/health', url).toString(),
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
}

/** The configured daily cap, never above the hard ceiling. */
export function dailyCap(env: SuperfanEnv) {
  const configured = Number(env.DAILY_CAP_MICROUSD ?? HARD_DAILY_CAP_MICROUSD);
  if (!Number.isSafeInteger(configured) || configured < 0) return 0;
  return Math.min(configured, HARD_DAILY_CAP_MICROUSD);
}
