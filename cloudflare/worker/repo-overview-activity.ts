// Completed Overview activity only. Admission and principal redaction run afresh outside
// this cache; mutable latest checks never enter it. No unfinished I/O crosses requests.
import type { Json, RepoContext } from './repo-ops';
import { record } from './repo-timing';

type Bounds = { entries: number; bytes: number; entry: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An isolate's bounded serialized results, copied on retrieval so callers cannot mutate
 * another viewer's answer. Both keys and encoded values count toward the byte budget. */
export class ActivityMemo {
  readonly #items = new Map<string, { bytes: Uint8Array; size: number }>();
  #bytes = 0;
  constructor(
    private readonly bounds: Bounds = {
      entries: 128,
      bytes: 4 * 1024 * 1024,
      entry: 256 * 1024,
    },
  ) {}

  get(key: string): Json | undefined {
    const item = this.#items.get(key);
    if (!item) return;
    this.#items.delete(key);
    this.#items.set(key, item);
    return JSON.parse(decoder.decode(item.bytes));
  }

  put(key: string, value: Json) {
    const bytes = encoder.encode(JSON.stringify(value));
    const size = bytes.byteLength + encoder.encode(key).byteLength;
    if (size > this.bounds.entry || size > this.bounds.bytes) return;
    const old = this.#items.get(key);
    if (old) this.#bytes -= old.size;
    this.#items.delete(key);
    this.#items.set(key, { bytes, size });
    this.#bytes += size;
    for (const [oldest, item] of this.#items) {
      if (this.#bytes <= this.bounds.bytes && this.#items.size <= this.bounds.entries) break;
      this.#items.delete(oldest);
      this.#bytes -= item.size;
    }
  }
}

const completed = new ActivityMemo();
const version = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

function key(ctx: RepoContext, status: Json, ref: string, commit: string, at: number) {
  // Fork provenance and restricted results retain their existing authoritative path.
  if (
    status.parent != null ||
    status.grant !== null ||
    typeof status.object_store !== 'string' ||
    !version(status.version) ||
    !version(status.quarantine_epoch) ||
    typeof status.history_chain !== 'string' ||
    !status.history_chain ||
    !version(at)
  )
    return null;
  return JSON.stringify([
    'overview-activity-v1',
    ctx.repo,
    status.object_store,
    status.history_chain,
    commit,
    ref,
    at,
    status.quarantine_epoch,
  ]);
}

/** The chart DTO omits log-only messages, trees, paths and break-glass history. */
function compact(value: Json): Json {
  return {
    commits: (value.commits as Json[]).map(
      ({ commit, principal, author_name, authored_at, landed }) => ({
        commit,
        principal,
        author_name,
        authored_at,
        landed: landed ? { landed_at: landed.landed_at } : null,
      }),
    ),
  };
}

/** Opt-in presentation only: the ordinary log already performed current admission.
 * Outer REST principal redaction still applies, and off/older deployments keep full logs. */
export function activityLogView(
  env: Pick<RepoContext['env'], 'OVERVIEW_DEFER_ACTIVITY'>,
  query: Json,
  value: Json,
): Json {
  return env.OVERVIEW_DEFER_ACTIVITY === 'on' &&
    query.view === 'overview' &&
    query.path === undefined &&
    query.dir === undefined
    ? { version: value.version, ref: value.ref, ...compact(value) }
    : value;
}

/** Fresh successful status must precede this call. A racing current log has a history
 * chain this admission did not observe, so it cannot populate an earlier version's key. */
export async function overviewActivity(
  ctx: RepoContext,
  status: Json,
  ref: string,
  commit: string,
  query: URLSearchParams,
  memo = completed,
): Promise<Json> {
  const at = query.has('at') ? Number(query.get('at')) : status.version;
  const lookup =
    !query.has('at') || at <= status.version ? key(ctx, status, ref, commit, at) : null;
  const hit = lookup && memo.get(lookup);
  if (hit) {
    record('overview.activity.hit', 0);
    return hit;
  }
  record('overview.activity.miss', 0);
  const value = await ctx.call({
    op: 'repo_log',
    ref,
    from: commit,
    limit: 200,
    ...(query.has('at') && { at }),
  });
  const result = compact(value);
  const actual = value.version === at && key(ctx, status, ref, commit, value.version);
  // Author backfill fills legacy nulls without moving the transaction-log version.
  // Keep asking the authority until all displayed authors are complete.
  if (
    actual &&
    result.commits.every(
      (c: Json) => Number.isSafeInteger(c.authored_at) && typeof c.author_name === 'string',
    )
  )
    memo.put(actual, result);
  return result;
}
