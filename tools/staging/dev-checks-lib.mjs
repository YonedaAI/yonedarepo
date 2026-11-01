// Pure parts of the enterprise checks (dev-checks.mjs): what a run may touch, which copies of a
// repository exist and what proves each one gone, what a run's log lines say, and the window's
// label. No I/O here, so tests/runtime/dev-checks.test.mjs covers it without a platform.
import { dirname } from 'node:path';

export const DEV = { origin: 'https://dev.yonedarepo.com', api: 'https://api.dev.yonedarepo.com' };

/** Every repository and org a run makes starts with this, so a leftover is plain to see. */
export const NAME_PREFIX = 'dev-check-';
/** The owner's dev test repositories (AGENTS.md): never made, read or deleted here. */
export const KEPT_REPOS = ['oss-click', 'oss-commander', 'oss-cobra', 'testing', 'claude-code-fresh'];

/** The bounds the erase path is built to: repo-admin.ts R2_PAGE, erase.rs ROW_BUDGET and
 * BYTE_BUDGET, repo-erase.ts STEPS_PER_JOB, repo-deleted.ts SWEEP_LIMIT and SEND_AGAIN_MS. */
export const LIMITS = {
  r2Page: 1000,
  rowsPerStep: 2000,
  bytesPerStep: 8 * 1024 * 1024,
  stepsPerJob: 100,
  purgesPerSweep: 50,
  sendAgainMs: 6 * 60 * 60 * 1000,
  shards: 64,
};

/** A short window is what lets a run see both sides of it: 0.05 days is 72 minutes. */
const LONGEST_TEST_WINDOW_DAYS = 0.05;

/** Throws unless `origin` is dev: this tool has no way to reach production. */
export function requireDev(origin) {
  if (origin !== DEV.origin) throw new Error(`Dev only: refusing ${origin}`);
  return origin;
}

/** What this run made, the only things it may delete. */
export class Ledger {
  #repos = new Map();
  #orgs = new Set();
  add({ id, name, ...rest }) {
    if (!name?.startsWith(NAME_PREFIX)) throw new Error(`Not a test name: ${name}`);
    if (KEPT_REPOS.includes(name)) throw new Error(`Kept repository: ${name}`);
    const entry = { id, name, deleted: false, erased: false, ...rest };
    this.#repos.set(id, entry);
    return entry;
  }
  addOrg(org) {
    if (!org.startsWith(NAME_PREFIX.replaceAll('-', '_'))) throw new Error(`Not a test org: ${org}`);
    this.#orgs.add(org);
    return org;
  }
  repo(id) {
    const entry = this.#repos.get(id);
    if (!entry) throw new Error(`Not made by this run: ${id}`);
    return entry;
  }
  /** The delete path of a repository of this run; anything else throws. */
  deletePath(id) {
    const { name } = this.repo(id);
    return `/repos/${id}?confirm=${encodeURIComponent(name)}`;
  }
  orgPath(org) {
    if (!this.#orgs.has(org)) throw new Error(`Not made by this run: ${org}`);
    return `/orgs/${org}?confirm=${encodeURIComponent(org)}`;
  }
  get repos() {
    return [...this.#repos.values()];
  }
  get orgs() {
    return [...this.#orgs];
  }
}

/** The window as a test sees it, always labelled. Refuses a window no run can wait out. */
export function shortWindow(days) {
  if (!(days > 0)) throw new Error('REPO_UNDO_DAYS is off on this deploy: nothing waits, so nothing can be undone');
  if (days > LONGEST_TEST_WINDOW_DAYS) throw new Error(`The window is ${days} days: this needs the short test window`);
  const ms = Math.round(days * 86_400_000);
  return { ms, days, label: `SHORT TEST WINDOW, dev only: ${Math.round(ms / 1000)} s, not the 30 days of the plan` };
}

/** D1's rows of one repository, as `[table, column]`. Reads only (`cloudflare.d1`). */
export const D1_ROWS = [
  ['platform_repos', 'id'],
  ['platform_members', 'repo'],
  ['platform_activity', 'repo'],
  ['platform_deleted_repos', 'id'],
  ['repositories', 'id'],
];

const ARTIFACTS = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/;
const R2_STORE = /^r2:([A-Za-z0-9._-]+)$/;

/** The R2 prefixes that hold a repository of store `store`. `audit/v1/<org>/` is left out on
 * purpose: a purge never touches it, and an org's log outlives its repositories. */
export function r2Prefixes(repo, store = '') {
  const r2 = R2_STORE.exec(store);
  return [`platform/v1/${repo}/`, `derived/v1/${repo}/`, ...(r2 ? [`store/v1/${r2[1]}/`] : [])];
}

/** The Artifacts repository of store `store`, or null when it has no mirror. */
export function mirrorOf(store = '') {
  const found = ARTIFACTS.exec(store);
  return found ? { namespace: found[1], name: found[2] } : null;
}

/** The first folder under a repository's prefix, for keys `platform/v1/<repo>/<kind>/...`. */
export const keyKind = (key) => key.split('/')[3] ?? '';

/** Every copy a snapshot still sees, by name: empty when all are gone. */
export function copiesLeft(snapshot) {
  const left = [];
  for (const [table, n] of Object.entries(snapshot.d1)) if (n > 0) left.push(`d1:${table}=${n}`);
  for (const [prefix, seen] of Object.entries(snapshot.r2)) if (seen.keys > 0) left.push(`r2:${prefix}=${seen.keys}`);
  if (snapshot.artifacts?.exists) left.push(`artifacts:${snapshot.artifacts.name}`);
  if (snapshot.object && snapshot.object.state !== 'erased') left.push(`object:${snapshot.object.state}`);
  return left;
}

/**
 * One row per copy: `gone`, `left`, or `not exercised` when nothing was there to begin with. A
 * probe that saw nothing before proves nothing after, so that row is never `gone`.
 */
export function proofTable(before, after) {
  const row = (copy, was, now) => ({ copy, before: was, after: now, verdict: now > 0 ? 'left' : was > 0 ? 'gone' : 'not exercised' });
  const rows = [];
  for (const [table, n] of Object.entries(after.d1)) rows.push(row(`d1 ${table}`, before.d1[table] ?? 0, n));
  for (const [prefix, seen] of Object.entries(after.r2)) rows.push(row(`r2 ${prefix}`, before.r2[prefix]?.keys ?? 0, seen.keys));
  rows.push(row('artifacts mirror', before.artifacts?.exists ? 1 : 0, after.artifacts?.exists ? 1 : 0));
  rows.push(row('repository object', before.object ? 1 : 0, !after.object || after.object.state === 'erased' ? 0 : 1));
  return rows;
}

/** Concatenated JSON objects, as `wrangler tail --format json` writes them, pretty-printed one
 * after another. A partial last object (the tail was stopped) is dropped. */
export function parseTail(text) {
  const events = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' && depth++ === 0) start = i;
    else if (c === '}' && --depth === 0) {
      try {
        events.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        // Not an event: wrangler's own banner can hold braces.
      }
    }
  }
  return events;
}

/** The platform's own log lines (log.ts: one JSON object each) of tail events. */
export function logLines(events) {
  const lines = [];
  for (const event of events)
    for (const log of event.logs ?? [])
      for (const message of log.message ?? []) {
        let fields = message;
        if (typeof message === 'string') {
          try {
            fields = JSON.parse(message);
          } catch {
            continue;
          }
        }
        if (fields?.event) lines.push({ at: log.timestamp, ...fields });
      }
  return lines;
}

/** What the erase of `repo` logged: its jobs and how far each went. */
export function eraseStory(events, repo) {
  const lines = logLines(events).filter((l) => l.event === 'repo.erase' && l.repo === repo);
  const jobs = lines.filter((l) => l.phase === 'records' || l.phase === 'erased');
  const objects = lines.find((l) => l.phase === 'objects');
  const erased = lines.find((l) => l.phase === 'erased');
  const outcomes = {};
  for (const event of events) outcomes[event.outcome ?? 'unknown'] = (outcomes[event.outcome ?? 'unknown'] ?? 0) + 1;
  return {
    jobs: jobs.length,
    rows: jobs.reduce((n, l) => n + (l.rows ?? 0), 0),
    most_rows_in_a_job: jobs.reduce((n, l) => Math.max(n, l.rows ?? 0), 0),
    shards_cleared: Boolean(objects),
    db_bytes_at_start: objects?.db_bytes ?? null,
    db_bytes_at_end: erased?.db_bytes ?? null,
    erase_ms: objects && erased ? erased.at - objects.at : null,
    waits: lines.filter((l) => ['hooks', 'audit', 'blocked'].includes(l.phase)).length,
    outcomes,
  };
}

/** Which of the erase's bounds a story breaks, by name. What a story can't show is said by
 * `unseen`: the log counts rows per job, never per transaction or bytes. */
export function limitsBroken(story) {
  const broken = [];
  if (story.most_rows_in_a_job > LIMITS.rowsPerStep * LIMITS.stepsPerJob) broken.push(`a job deleted ${story.most_rows_in_a_job} rows`);
  const need = Math.ceil(story.rows / (LIMITS.rowsPerStep * LIMITS.stepsPerJob));
  if (story.jobs < need) broken.push(`${story.rows} rows took ${story.jobs} jobs, at least ${need} expected`);
  for (const [outcome, n] of Object.entries(story.outcomes)) if (outcome !== 'ok') broken.push(`${n} invocations ended ${outcome}`);
  return broken;
}

export const unseen = 'Per transaction: 2,000 rows and 8 MB are not logged; this run bounds them by rows per job and by no object reset.';

/** The expected `{action, target}` rows that `rows` lacks. */
export function auditGaps(expected, rows) {
  const seen = new Set(rows.map((r) => `${r.action} ${r.target}`));
  return expected.filter((e) => !seen.has(`${e.action} ${e.target}`));
}

/** `[status, code]` of a `Session.raw` answer. */
export const refusal = (answer) => [answer.status, answer.body?.error?.code ?? null];

/** The repository root, from `git rev-parse --git-common-dir`: evidence stays there, whichever
 * worktree runs this. */
export const rootOf = (commonDir) => dirname(commonDir);

/** `text` with every secret replaced. */
export const scrub = (text, secrets) =>
  [...secrets].filter(Boolean).reduce((out, secret) => out.split(secret).join('<secret>'), String(text));
