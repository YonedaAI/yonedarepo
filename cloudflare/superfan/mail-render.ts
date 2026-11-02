// An alert mail, for someone with ten seconds: the environment and the worst thing in the
// subject, then one block per cause saying what is wrong, since when, how often and what to do
// first. Blocks are built from signals, not findings: one finding can hold several causes, and
// one cause can span findings (a queue's dead letters and its waiting messages). The HTML is
// inline-styled with no backgrounds or images, so a client's light or dark theme carries it, and
// sits beside a plain text part with the same facts.
import type { SuperfanEnv } from './config';
import type { FindingRow } from './ledger';
import {
  COPY,
  type Copy,
  capital,
  type Facts,
  type Link,
  nounOf,
  TELEMETRY_COPY,
  UNKNOWN,
  WORD,
} from './mail-copy';
import type { Finding } from './model';

/** Where an environment's pages are; only the two watchable scripts exist (config.ts). */
export interface MailSite {
  env: string;
  site: string;
  api: string;
}
export type Mail = { subject: string; text: string; html: string };
interface Item {
  title: string;
  means: string;
  /** A monitoring fault's own reason, under `means`. */
  detail: string | null;
  since: string | null;
  seen: string;
  /** The release it began on, and the one it is on now if that differs. */
  release: string | null;
  first: string;
  link: { label: string; href: string } | null;
  guess: string | null;
  rank: number;
  count: number;
}
interface Group {
  copy: Copy;
  component: string;
  rows: FindingRow[];
  values: Facts['values'];
  baseline?: number;
  /** Which rows the signal named. */
  detail?: string;
}

const GUIDE = 'https://github.com/YonedaAI/yonedarepo/blob/dev/docs/incidents.md';
const LOGS = 'Logs: Cloudflare → Workers & Pages → the Worker → Observability.';
const GUESS_LABEL = 'A guess, unchecked:';
/** Longer than this, a guess is prose, not something to read in ten seconds. */
const GUESS_MAX = 140;
const DETAIL_MAX = 120;
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** Monitoring's faults sit here in the worst-first order: above a Worker's errors. */
const TELEMETRY_RANK = COPY.findIndex((c) => c.signals.includes('error_rate')) - 0.5;

export function mailSite(env: SuperfanEnv): MailSite {
  return env.WATCH_SCRIPT.includes('-prod-')
    ? { env: 'prod', site: 'https://yonedarepo.com', api: 'https://api.yonedarepo.com' }
    : { env: 'dev', site: 'https://dev.yonedarepo.com', api: 'https://api.dev.yonedarepo.com' };
}

const readable = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};
const seen = (times: number) =>
  times === 1
    ? 'Seen once.'
    : times === 2
      ? 'Seen twice.'
      : `Seen ${times.toLocaleString('en-US')} times.`;

const short = (revision: string) => revision.slice(0, 12);
/** Which release to look at: a mail reader's "what changed?". */
function release({ revision, last_revision: last }: FindingRow) {
  if (!revision) return null;
  return last && last !== revision
    ? `First on ${short(revision)}, now on ${short(last)}.`
    : `On ${short(revision)}.`;
}

type Stored = {
  signals?: { name: string; value: number | null; baseline?: number; detail?: string }[];
};
type Samples = { exception_samples?: unknown[] };
const rulesOf = (f: FindingRow) => (f.dedup_key.split(':')[1] ?? '').split('+');
const copyOf = (component: string, rule: string) =>
  (component === 'telemetry' ? TELEMETRY_COPY[rule] : COPY.find((c) => c.signals.includes(rule))) ??
  UNKNOWN;
const rankOf = (copy: Copy) => {
  const index = COPY.indexOf(copy);
  if (index >= 0) return index;
  return copy === UNKNOWN ? COPY.length : TELEMETRY_RANK;
};

/**
 * The model's likely cause, if a reader should see it: only with log text behind it (from numbers
 * alone it invents causes), short, naming nothing internal, and with no link, as it is built from
 * exception text. It goes out labelled as a guess.
 */
export function guess(f: FindingRow): string | null {
  const cause = (f.narrative as Finding | null)?.likely_cause;
  if (!cause || !(f.signals as Samples | null)?.exception_samples?.length) return null;
  let text = cause.replace(/\s+/g, ' ').trim();
  for (const [key, word] of Object.entries(WORD)) text = text.replaceAll(key, word);
  if (!text || /^unknown\b/i.test(text) || text.length > GUESS_MAX) return null;
  if (/:\/\/|www\.|\b[a-z]+_[a-z_]+\b/i.test(text)) return null;
  return text;
}

function groups(findings: FindingRow[]) {
  const found = new Map<string, Group>();
  for (const f of findings)
    for (const rule of rulesOf(f)) {
      const copy = copyOf(f.component, rule);
      const key = `${f.component}/${copy === UNKNOWN ? rule : copy.signals[0]}`;
      const group = found.get(key) ?? { copy, component: f.component, rows: [], values: {} };
      found.set(key, group);
      if (!group.rows.includes(f)) group.rows.push(f);
      const signal = (f.signals as Stored | null)?.signals?.find((s) => s.name === rule);
      group.values[rule] = signal?.value ?? null;
      if (signal?.baseline !== undefined) group.baseline = signal.baseline;
      if (signal?.detail) group.detail = signal.detail;
      if (signal?.detail) group.detail = signal.detail;
    }
  return [...found.values()];
}

function item(group: Group, site: MailSite): Item {
  const { copy, component, rows, values, baseline, detail } = group;
  const facts: Facts = {
    values,
    word: WORD[component] ?? 'service',
    noun: nounOf(component),
    baseline,
    detail,
  };
  const earliest = rows.map((f) => f.first_seen).sort()[0];
  const link: Link | undefined = copy.link?.(component);
  const [only] = rows;
  const oldest = rows.reduce((a, b) => (b.first_seen < a.first_seen ? b : a));
  return {
    title: copy.title(facts),
    means: typeof copy.means === 'string' ? copy.means : copy.means(facts),
    detail: detail ?? (copy.reason ? only.summary.slice(0, DETAIL_MAX) : null),
    since: readable(earliest),
    seen: seen(Math.max(...rows.map((f) => f.occurrences))),
    release: release(oldest),
    first: copy.firstOn?.[component] ?? copy.first,
    link: link
      ? { label: link.label, href: `${link.api ? site.api : site.site}${link.path}` }
      : null,
    guess: rows.length === 1 ? guess(only) : null,
    rank: rankOf(copy),
    // The number its title leads with: the first of the cause's signals that fired.
    count: copy.signals.map((name) => values[name]).find((v) => typeof v === 'number') ?? 0,
  };
}

const when = (i: Item) =>
  [i.since && `Since ${i.since}.`, i.seen, i.release].filter(Boolean).join(' ');

function plain(heading: string, items: Item[]) {
  const block = (i: Item) =>
    [
      i.title,
      i.means,
      ...(i.detail ? [i.detail] : []),
      when(i),
      `First: ${i.first}`,
      ...(i.link ? [`${i.link.label}: ${i.link.href}`] : []),
      ...(i.guess ? [`${GUESS_LABEL} ${i.guess}`] : []),
    ].join('\n');
  return [heading, ...items.map(block), `Incident guide: ${GUIDE}\n${LOGS}`]
    .join('\n\n')
    .concat('\n');
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const text = (body: string, style = '') =>
  `<p style="margin:0 0 6px;font-size:15px;line-height:1.45;${style}">${body}</p>`;
const muted = (body: string) =>
  `<p class="muted" style="margin:0 0 6px;font-size:14px;line-height:1.45;color:#6b6b6b">${body}</p>`;
const anchor = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="color:#1d4ed8;text-decoration:underline">${escapeHtml(label)}</a>`;

function html(subject: string, heading: string, items: Item[], urgent: boolean) {
  const bar = urgent ? '#d92d20' : '#8a8a8a';
  const block = (i: Item) =>
    `<div style="margin:0 0 24px;padding:0 0 0 14px;border-left:3px solid ${bar}">
${text(escapeHtml(i.title), 'font-size:17px;font-weight:600;line-height:1.3')}
${text(escapeHtml(i.means))}
${i.detail ? muted(escapeHtml(i.detail)) : ''}
${muted(escapeHtml(when(i)))}
${text(`<strong>First:</strong> ${escapeHtml(i.first)}`, 'margin-top:10px')}
${i.link ? text(anchor(i.link.href, i.link.label)) : ''}
${i.guess ? muted(`<em>${GUESS_LABEL}</em> ${escapeHtml(i.guess)}`) : ''}
</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .muted { color: #a8a8a8 !important; }
  a { color: #7aa7ff !important; }
}
</style>
</head>
<body style="margin:0;padding:20px 16px;font-family:${FONT}">
<div style="max-width:540px;margin:0 auto">
${text(escapeHtml(heading), 'margin:0 0 20px;font-weight:600')}
${items.map(block).join('\n')}
<hr style="border:0;border-top:1px solid #8a8a8a;margin:0 0 12px">
${muted(anchor(GUIDE, 'Incident guide'))}
${muted(escapeHtml(LOGS))}
</div>
</body>
</html>
`;
}

function render(site: MailSite, findings: FindingRow[], urgent: boolean): Mail {
  const items = groups(findings)
    .map((g) => item(g, site))
    .sort((a, b) => a.rank - b.rank || b.count - a.count);
  const more = items.length > 1 ? ` +${items.length - 1} more` : '';
  const tag = urgent ? `URGENT ${site.env}` : site.env;
  const subject = `[${tag}] ${capital(items[0].title)}${more}`;
  const things = items.length === 1 ? '1 thing' : `${items.length} things`;
  const heading = urgent
    ? `Needs attention now on ${site.env}.`
    : `${things} to look at on ${site.env}.`;
  return { subject, text: plain(heading, items), html: html(subject, heading, items, urgent) };
}

export const renderNotice = (site: MailSite, findings: FindingRow[]) =>
  render(site, findings, false);
export const renderUrgent = (site: MailSite, findings: FindingRow[]) =>
  render(site, findings, true);
