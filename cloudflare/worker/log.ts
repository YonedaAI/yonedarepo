// The one way Worker code writes a log line: one JSON object per line, indexed by Workers Logs
// (docs/logging.md). `event` comes first because readers match on it (Superfan's tail, the SSH
// end-to-end test). Writing a line can neither fail nor delay what asked for it: a line is
// synchronous, never awaited, and everything in it is built inside a try.
//
// Fields are allow-listed: a key that is not in FIELDS is dropped, so a spread of some object
// cannot put a credential or file content in a log. Every string value is scrubbed as well,
// because an error message quotes whatever failed.
import { currentScope, inScope, requestId, type Seed, withRequestId } from './request-scope';

const FIELDS = [
  'component',
  'source',
  'traffic',
  'actor',
  'origin',
  'span_id',
  'parent_span_id',
  'parent_request_id',
  'queue_wait_ms',
  'authority_region',
  'region',
  'navigation_id',
  'account',
  'after',
  'at',
  'attempt',
  'attempts',
  'builder',
  'by',
  'bytes',
  'cache',
  'client_ms',
  'code',
  'count',
  'cpu_ms',
  'db_bytes',
  'edge',
  'elapsed_ms',
  'entries',
  'error',
  'exit_code',
  'fetch',
  'first_byte_ms',
  'floor',
  'from_platform',
  'forks',
  'from',
  'head',
  'hooks',
  'host',
  'id',
  'index',
  'label',
  'large',
  'largest',
  'ledger_usd',
  'line',
  'message',
  'method',
  'mirror',
  'missing',
  'ms',
  'name',
  'objects',
  'operation',
  'outcome',
  'packs',
  'path',
  'peak_mib',
  'phase',
  'pid',
  'platform_ms',
  'problem',
  'provider',
  'r2',
  'ran_s',
  'raw',
  'raw_mib',
  'read',
  'read_wait_ms',
  'reason',
  'requested',
  'retrying',
  'route',
  'rows',
  'rollup_usd',
  'run',
  'sent_mib',
  'seq',
  'served',
  'service',
  'spans',
  'start_ms',
  'stalled',
  'started',
  'status',
  'step',
  'store',
  'stripe_usd',
  'tail',
  'tail_rows',
  'threshold',
  'tiers',
  'tip',
  'to',
  'top_up',
  'total_ms',
  'transcripts',
  'transient',
  'tries',
  'tunnel',
  'url',
  'walk_ms',
  'wasm',
  'wasm_mib',
  'why',
] as const;
const ALLOWED: ReadonlySet<string> = new Set(FIELDS);

/** Bounds a value: the line as a whole is bounded by LINE_LIMIT. */
const VALUE_LIMIT = 500;
const LINE_LIMIT = 4000;
const LIST_LIMIT = 20;
const DEPTH_LIMIT = 2;

export type LogField = (typeof FIELDS)[number];
export type Fields = { [K in LogField]?: unknown } & {
  repo?: string;
  job?: string;
  kind?: string;
};
type Level = 'info' | 'warn' | 'error';

const REDACTED = '[redacted]';
/** Exact shapes a long run may keep: a commit or content hash, a request id. */
const KEPT = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const REDACTIONS: [RegExp, string | ((found: string) => string)][] = [
  [/\b(Bearer|Basic|token)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`],
  [/:\/\/[^/\s"'@]+@/g, `://${REDACTED}@`],
  [
    /((?:^|[?&;\s"'])(?:[a-z_-]*(?:token|secret|password|passwd|key|signature|credential)|sig|auth|authorization|cookie|x-amz-[a-z-]+)["']?[=:]\s*["']?)[^&\s"';,]+/gi,
    `$1${REDACTED}`,
  ],
  [/\byoneda_account=[^\s;"']+/g, `yoneda_account=${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/g, REDACTED],
  [
    /\b(?:yrp_|ypat_|yoneda\.|ttp-|tp-|sk-|sk_|rk_|whsec_|ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9._-]+/g,
    REDACTED,
  ],
  [/[^\s"'<>(),;:]+@[^\s"'<>(),;:]+\.[^\s"'<>(),;:]+/g, '[email]'],
  [/[A-Za-z0-9_+=-]{33,}/g, (found) => (KEPT.test(found) ? found : REDACTED)],
];

/** `text` without anything shaped like a credential or an email address, bounded. */
export function scrub(text: string) {
  let clean = text;
  for (const [shape, replacement] of REDACTIONS)
    clean = clean.replace(shape, replacement as string);
  return clean.slice(0, VALUE_LIMIT);
}

/** What a failure says, safe to log. V8's JSON errors quote the text they failed on, and that
 * text can be a file's content. */
export function errorText(e: unknown) {
  if (e instanceof SyntaxError) return 'SyntaxError';
  const text = String((e as Error)?.message ?? e);
  return / is not valid JSON|^Unexpected (?:token|end of)/.test(text) ? 'SyntaxError' : scrub(text);
}

function value(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return scrub(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Error) return errorText(v);
  if (typeof v !== 'object' || depth >= DEPTH_LIMIT) return undefined;
  if (Array.isArray(v)) return v.slice(0, LIST_LIMIT).map((item) => value(item, depth + 1));
  return allowed(v as Record<string, unknown>, depth + 1);
}

function allowed(fields: Record<string, unknown>, depth = 0) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (!ALLOWED.has(key)) continue;
    const clean = key === 'error' ? errorValue(fields[key], depth) : value(fields[key], depth);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

const errorValue = (e: unknown, depth: number) =>
  typeof e === 'string'
    ? scrub(e)
    : typeof e === 'object' && e !== null
      ? errorText(e)
      : value(e, depth);

const repoIn = (url?: string) => url && /\/(r[0-9a-f]{20})(?:[/.?]|$)/.exec(url)?.[1];

function line(level: Level, event: string, fields: Fields) {
  const scope = currentScope();
  const job = scope?.job;
  const head = {
    event,
    level,
    request_id: requestId(scope),
    repo: scrubbed(fields.repo ?? job?.repo_id ?? repoIn(scope?.req?.url)),
    job: scrubbed(fields.job ?? job?.job_id),
    kind: scrubbed(fields.kind ?? job?.kind),
    revision: scope?.env?.BUILD_REVISION,
  };
  const { repo: _repo, job: _job, kind: _kind, ...rest } = fields;
  const code = (rest.error as { code?: unknown } | undefined)?.code;
  if (rest.code === undefined && typeof code === 'string') rest.code = code;
  const text = JSON.stringify({ ...head, ...allowed(rest) });
  return text.length <= LINE_LIMIT ? text : JSON.stringify({ ...head, truncated: true });
}

const scrubbed = (v: unknown) => (typeof v === 'string' ? scrub(v) : undefined);

const SINK = { info: 'log', warn: 'warn', error: 'error' } as const;

function write(level: Level, event: string, fields: Fields) {
  try {
    console[SINK[level]](line(level, event, fields));
  } catch {
    // A line that cannot be written must not become the request's problem.
  }
}

export const log = {
  info: (event: string, fields: Fields = {}) => write('info', event, fields),
  warn: (event: string, fields: Fields = {}) => write('warn', event, fields),
  error: (event: string, fields: Fields = {}) => write('error', event, fields),
};

/** A `.catch` for a failure nobody is waiting on: a line, and null for the caller's fallback. */
export const warned =
  (event: string, fields: Fields = {}) =>
  (e: unknown): null => {
    log.warn(event, { ...fields, error: e });
    return null;
  };

/** The route of `req`: never an account, a repository's name or a file path. */
export function operationOf(req: Request) {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const word = (part?: string) => part && /^[a-z][a-z0-9_-]{0,31}$/.test(part);
  let route = '/:path';
  if (parts[0] === 'git') route = '/git/:repo';
  else if (parts[0] === 'api' && word(parts[1])) {
    const [, group, resource, , action] = parts;
    route = `/api/${group}`;
    if (word(resource)) route += `/${resource}`;
    if (parts.length > 3) route += resource === 'repos' ? '/:repo' : '/:id';
    if (resource === 'repos' && word(action)) route += `/${action}`;
  }
  return `${req.method} ${route}`;
}

/** Logs a failure the platform did not plan for: the one line a forced 500 must leave. */
export function logFailure(e: unknown, code: string, status: number, extra: Fields = {}) {
  const req = currentScope()?.req;
  log.error('request.failed', {
    ...(req && { operation: operationOf(req) }),
    code,
    status,
    error: e,
    ...extra,
  });
}

/** An entrypoint's `fetch`: the scope, the id on the response, and a line for what no route
 * caught. That failure is rethrown: Cloudflare's own outcome and error page stay as they are. */
export function served(seed: Seed, run: () => Promise<Response>) {
  return inScope(seed, async () => {
    try {
      return withRequestId(await run());
    } catch (e) {
      logFailure(e, 'UNCAUGHT', 500);
      throw e;
    }
  });
}
