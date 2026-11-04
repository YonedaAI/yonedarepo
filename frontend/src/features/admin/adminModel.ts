// The admin pages' model (operators only; every answer comes from `/api/v1/admin`, which
// checks for itself): the sections, the API's shapes and paths, the sign-ups unread marker
// this browser keeps, and the labels the pages show.
import type { AdminReports } from '../../../../shared/platform-reports';

export const ADMIN_SECTIONS = [
  'overview',
  'users',
  'signups',
  'repos',
  'audit',
  'traffic',
  'visitors',
  'agents',
  'operations',
  'infrastructure',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];
export const isAdminSection = (value: string | undefined): value is AdminSection =>
  (ADMIN_SECTIONS as readonly string[]).includes(value ?? '');
export const SECTION_LABEL: Record<AdminSection, string> = {
  overview: 'Overview',
  users: 'Users',
  signups: 'Sign-ups',
  repos: 'Repositories',
  audit: 'Audit log',
  traffic: 'Traffic',
  visitors: 'Visitors',
  agents: 'Agents',
  operations: 'Operations',
  infrastructure: 'Infrastructure',
};
/** The tabs only some platforms have, and what the shell's sign-up feed says about them. */
export const shownSections = (reports?: AdminReports) =>
  ADMIN_SECTIONS.filter((id) =>
    id === 'visitors'
      ? reports?.visitors
      : id === 'agents'
        ? reports?.agents
        : id === 'operations' || id === 'infrastructure'
          ? reports?.operations
          : true,
  );

export type Overview = {
  accounts: { total: number; new_24h: number; new_7d: number; new_30d: number; active_7d: number };
  suspended: number;
  repos: { public: number; private: number };
  signups_per_day: { day: string; count: number }[];
  /** Whether the revenue view exists here (ADMIN_BILLING). */
  billing?: boolean;
  /** The Flight log's confirmed subscribers, while NEWSLETTER is on. */
  newsletter?: { confirmed: number } | null;
};
export type AdminAccount = {
  account: string;
  handle: string | null;
  provider: string;
  created_at: number;
  last_seen_at: number | null;
  repos: number;
  suspended: boolean;
  suspended_at: number | null;
  /** Ours: left out of every figure. */
  internal: boolean;
};
export type AdminRepo = {
  id: string;
  name: string;
  owner: string;
  handle: string | null;
  visibility: 'public' | 'private';
  created_at: number;
};
/** A repository's database now (null when it could not be read). */
export type RepoDetail = AdminRepo & {
  storage: { db_bytes: number; table_rows: Record<string, number> } | null;
};
export type Page<T, Cursor = number> = { items: T[]; next: Cursor | null; partial?: boolean };
export type Credit = {
  balance: { granted: number; used: number; balance: number };
  entries: { id: number; at: number; kind: string; amount: number; note: string | null }[];
};
export type AccountDetail = {
  account: string;
  indexed: boolean;
  internal: boolean;
  handle: string | null;
  email: string | null;
  providers: string[];
  password: boolean;
  orgs: string[];
  created_at: number | null;
  last_seen_at: number | null;
  suspended_at: number | null;
  repos: AdminRepo[];
  tokens: number | null;
  credit: Credit | null;
  /** Whether the Billing section exists here (ADMIN_BILLING). */
  billing?: boolean;
};
export type Signups = { items: AdminAccount[]; unread: number; reports?: AdminReports };
export type AuditEntry = {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  /** The rest come with OPERATOR_AUDIT on. */
  outcome?: string;
  request_id?: string | null;
  actor_kind?: 'person' | 'system';
  origin?: string | null;
  time_zone?: string | null;
};
export type AuditFilters = {
  view: 'people' | 'system';
  actor: string;
  action: string;
  target: string;
  outcome: string;
  from: string;
  to: string;
};
export const NO_FILTERS: AuditFilters = {
  view: 'people',
  actor: '',
  action: '',
  target: '',
  outcome: '',
  from: '',
  to: '',
};
export const OUTCOMES: Record<string, string> = {
  success: 'Done',
  failed: 'Failed',
  denied: 'Refused',
  requested: 'Requested',
  queued: 'Queued',
  completed: 'Completed',
};

export function withQuery(path: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return query.size ? `${path}?${query}` : path;
}
export const accountsPath = (q: string, before?: number) =>
  withQuery('/admin/accounts', { q: q.trim(), before });
export const repoPath = (repo: string) => `/admin/repos/${repo}`;
export const signupsPath = (since: number) => `/admin/signups?since=${since}`;
export const auditPath = (filters: AuditFilters, before?: number) =>
  withQuery('/admin/audit', { ...filters, before });
export const accountPath = (account: string) => `/admin/accounts/${encodeURIComponent(account)}`;

const PROVIDERS: Record<string, string> = { github: 'GitHub', google: 'Google', email: 'Email' };
export const providerLabel = (provider: string) => PROVIDERS[provider] ?? provider;
export const nameOf = (a: { account: string; handle: string | null }) => a.handle ?? a.account;

/** A time as a short date and time in the viewer's zone, or "never". */
export function when(at: number | null | undefined) {
  if (!at) return 'never';
  return new Date(at).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
/** A database size in decimal units, like the alert levels: `9.1 GB`, `120 MB`. */
export function dbSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} KB`;
}
/** The label of an alert level, or null below the first. */
export const storageAlert = (level: number | null) =>
  level === null ? null : `Over ${level / 1e9} GB`;
export const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** The sidebar badge's text: empty for none, capped at 99+. */
export const unreadLabel = (unread: number) =>
  unread <= 0 ? '' : unread > 99 ? '99+' : `${unread}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const SEEN_KEY = 'yoneda.admin.signups-seen';
const browserStore = (): Store | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage;
/** When this browser last looked at the sign-ups (0: never); storage may be blocked. */
export function readSeen(store: Store | undefined = browserStore()) {
  try {
    const n = Number(store?.getItem(SEEN_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
export function saveSeen(at: number, store: Store | undefined = browserStore()) {
  try {
    store?.setItem(SEEN_KEY, String(at));
  } catch {
    // Blocked storage only means the badge counts from the start again.
  }
}

/** A country's name from its ISO code, else the code (unknown or unsupported). */
export function countryName(code: string) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
