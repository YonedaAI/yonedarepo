// The admin pages' model (operators only; every answer comes from `/api/v1/admin`, which
// checks for itself): the sections, the API's shapes and paths, the sign-ups unread marker
// this browser keeps, and the labels and bar heights the pages show.

export const ADMIN_SECTIONS = [
  'overview',
  'users',
  'signups',
  'repos',
  'audit',
  'traffic',
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
};

export type Overview = {
  accounts: { total: number; new_24h: number; new_7d: number; new_30d: number; active_7d: number };
  suspended: number;
  repos: { public: number; private: number };
  signups_per_day: { day: string; count: number }[];
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
};
export type AdminRepo = {
  id: string;
  name: string;
  owner: string;
  handle: string | null;
  visibility: 'public' | 'private';
  created_at: number;
};
export type Page<T> = { items: T[]; next: number | null };
export type Credit = {
  balance: { granted: number; used: number; balance: number };
  entries: { id: number; at: number; kind: string; amount: number; note: string | null }[];
};
export type AccountDetail = {
  account: string;
  indexed: boolean;
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
};
export type Signups = { items: AdminAccount[]; unread: number };
export type AuditEntry = {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
};

function withQuery(path: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return query.size ? `${path}?${query}` : path;
}
export const accountsPath = (q: string, before?: number) =>
  withQuery('/admin/accounts', { q: q.trim(), before });
export const reposPath = (q: string, before?: number) =>
  withQuery('/admin/repos', { q: q.trim(), before });
export const signupsPath = (since: number) => `/admin/signups?since=${since}`;
export const auditPath = (before?: number) => withQuery('/admin/audit', { before });
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
export const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** The sidebar badge's text: empty for none, capped at 99+. */
export const unreadLabel = (unread: number) =>
  unread <= 0 ? '' : unread > 99 ? '99+' : `${unread}`;

/** Bar heights in percent of the busiest day; a day with any sign-up shows at least 4%. */
export function barHeights(counts: number[]) {
  const top = Math.max(0, ...counts);
  return counts.map((n) => (n > 0 ? Math.max(4, Math.round((n / top) * 100)) : 0));
}

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
