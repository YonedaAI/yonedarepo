// What a person reads. Findings here have the shape the ledger hands the mail; values are
// invented, and the worst of them copy real dev findings.
import { describe, expect, it } from 'vitest';
import type { Analytics } from '../../cloudflare/superfan/analytics';
import type { FindingRow } from '../../cloudflare/superfan/ledger';
import { COPY, TELEMETRY_COPY } from '../../cloudflare/superfan/mail-copy';
import {
  guess,
  type MailSite,
  mailSite,
  renderNotice,
  renderUrgent,
} from '../../cloudflare/superfan/mail-render';
import { evaluate, type Snapshot } from '../../cloudflare/superfan/signals';
import { testEnv } from './fake-platform';

const DEV: MailSite = {
  env: 'dev',
  site: 'https://dev.yonedarepo.com',
  api: 'https://api.dev.yonedarepo.com',
};
const SEEN = '2026-11-01T01:40:24.751Z';
let nextId = 50;

/** A finding of `key`, its signals carrying `values` as the ledger stores them. */
function row(
  key: string,
  values: Record<string, number | null> = {},
  over: Partial<FindingRow> & { samples?: unknown[] } = {},
): FindingRow {
  const [component, rules] = key.split(':');
  const { samples = [], ...rest } = over;
  const signals = Object.entries(values).map(([name, value]) => ({
    name,
    value,
    unit: 'count',
    anomalous: true,
    rule: '> 0',
  }));
  return {
    id: nextId++,
    dedup_key: key,
    component,
    kind: 'anomaly',
    level: 'urgent',
    status: 'open',
    signals: { signals, exception_samples: samples },
    summary: `${rules}=1 (> 0)`,
    narrative: null,
    narrative_status: 'pending',
    model: null,
    cost_microusd: 0,
    occurrences: 1,
    first_seen: SEEN,
    last_seen: SEEN,
    resolved_at: null,
    notified_at: null,
    ...rest,
  };
}

const narrative = (likely_cause: string) => ({
  title: 'Model title',
  what: 'Model prose about the numbers.',
  evidence: 'Model evidence',
  likely_cause,
  next_check: 'Model next check',
});
const dead = (id = 'derived_jobs') => [
  row(`${id}:dead_lettered`, { dead_lettered: 1066, dead_letter_backlog: 1516 }),
  row(`${id}:dead_letter_backlog`, { dead_lettered: 1066, dead_letter_backlog: 1516 }),
];

describe('subject', () => {
  it('leads with the environment and the worst thing, in plain words', () => {
    expect(renderUrgent(DEV, dead()).subject).toBe('[URGENT dev] 1,066 background jobs failed');
    const prod = { ...DEV, env: 'prod' };
    const down = row('front_worker:health', { health: 503 });
    expect(renderUrgent(prod, [down]).subject).toBe('[URGENT prod] Website health check failing');
  });

  it('names the worst first and counts the rest as one item each', () => {
    const { subject } = renderUrgent(DEV, [
      ...dead(),
      row('check_runs:dead_lettered', { dead_lettered: 2 }),
      row('api_worker:health', { health: null }),
    ]);
    expect(subject).toBe('[URGENT dev] API health check failing +2 more');
  });

  it('is one line under any findings', () => {
    const { subject } = renderNotice(DEV, [row('telemetry:config', {}, { kind: 'telemetry' })]);
    expect(subject).not.toMatch(/\n/);
  });
});

describe('blocks', () => {
  it('says what is wrong, since when, how many times and what to do first', () => {
    const { text } = renderUrgent(DEV, [
      row('front_worker:health', { health: 503 }, { occurrences: 3 }),
    ]);
    expect(text).toContain('Needs attention now on dev.');
    expect(text).toContain('Website health check failing');
    expect(text).toContain('It answered HTTP 503.');
    expect(text).toContain('Since 1 Nov, 01:40 UTC. Seen 3 times.');
    expect(text).toMatch(/First: .+/);
    expect(text).toContain('https://dev.yonedarepo.com/health');
  });

  it('counts one sighting in words', () => {
    expect(renderUrgent(DEV, dead()).text).toContain('Seen once.');
  });

  it('makes a dead letter count and its waiting queue one item, per queue', () => {
    const { text } = renderUrgent(DEV, dead());
    expect(text.match(/background jobs failed/g)).toHaveLength(1);
    expect(text).toContain('1,516 are waiting for a retry by hand.');
    const both = renderUrgent(DEV, [
      ...dead(),
      row('check_runs:dead_lettered', { dead_lettered: 2 }),
    ]);
    expect(both.text).toContain('2 check runs failed');
    expect(both.subject).toBe('[URGENT dev] 1,066 background jobs failed +1 more');
  });

  it('merges rows of one cause across findings, keeping the earliest and the most seen', () => {
    const { text } = renderUrgent(DEV, [
      row('derived_jobs:dead_lettered', { dead_lettered: 5 }, { occurrences: 2 }),
      row(
        'derived_jobs:dead_letter_backlog',
        { dead_letter_backlog: 7 },
        { occurrences: 9, first_seen: '2026-10-31T23:05:00.000Z' },
      ),
    ]);
    expect(text).toContain('Since 31 Oct, 23:05 UTC. Seen 9 times.');
  });

  it('splits one finding of several causes into one block each', () => {
    const { subject, text } = renderNotice(DEV, [
      row(
        'derived_jobs:backlog+backlog_growth+error_rate+exceptions',
        { backlog: 400, backlog_growth: 395, error_rate: 0.2757, exceptions: 360 },
        { level: 'digest' },
      ),
    ]);
    expect(subject).toBe('[dev] 27.6% of background job calls failing +1 more');
    expect(text).toContain('400 background jobs waiting');
    expect(text).toContain('2 things to look at on dev.');
  });

  it('reads only the rules of its own key, not the rest of the report', () => {
    const { text } = renderNotice(DEV, [
      row('api_worker:error_rate', { error_rate: 0.1, health: 503 }, { level: 'digest' }),
    ]);
    expect(text).toContain('10% of API calls failing');
    expect(text).not.toContain('health check');
  });

  it('links to an admin page where one helps', () => {
    const { text, html } = renderUrgent(DEV, [row('storage:storage_9gb', { storage_9gb: 1 })]);
    expect(text).toContain('Repository past 9 GB');
    expect(text).toContain('https://dev.yonedarepo.com/admin/repos');
    expect(html).toContain('href="https://dev.yonedarepo.com/admin/repos"');
  });

  it('adds commas to every count and picks units', () => {
    const { text } = renderNotice(DEV, [
      row('source_repository:p95_wall_ms', { p95_wall_ms: 1460 }, { level: 'digest' }),
      row('land_queue:land_timeouts', { land_timeouts: 12500 }, { level: 'digest' }),
    ]);
    expect(text).toContain('12,500 landings waited over 20 seconds');
    expect(text).toContain('1.5 s');
  });

  it('shows no internal rule text, keys, ids or raw times', () => {
    const rows = [
      ...dead(),
      row('derived_jobs:error_logs+error_rate+exceptions+retries_per_message', {
        error_logs: 3109,
        error_rate: 0.2757,
        exceptions: 360,
        retries_per_message: 2,
      }),
      row('telemetry:tail_silent', {}, { kind: 'telemetry', summary: 'No tail events this hour' }),
    ];
    for (const { subject, text, html } of [renderUrgent(DEV, rows), renderNotice(DEV, rows)]) {
      const shown = html
        .replace(/<style>[\s\S]*<\/style>/, '')
        .replace(/<[^>]+>/g, ' ')
        .replaceAll('&#39;', "'");
      const words = `${subject}\n${text}\n${shown}`;
      expect(words).not.toMatch(
        /\(> ?\d|>= ?\d|dead_lettered|dead_letter_backlog|derived_jobs|error_rate|anomaly|#\d+|GET \/|Superfan|\d{4}-\d\d-\d\dT/,
      );
    }
  });

  it('does not say an error count twice', () => {
    const { text } = renderNotice(DEV, [
      row('api_worker:exceptions', { exceptions: 3 }, { level: 'digest' }),
    ]);
    expect(text).toContain('3 API errors');
    expect(text).not.toContain('3 exceptions');
  });

  it('shows a monitoring fault its reason only where the reason adds something', () => {
    const fault = (key: string, summary: string) =>
      renderNotice(DEV, [row(key, {}, { kind: 'telemetry', level: 'digest', summary })]).text;
    expect(fault('telemetry:fetch_failed', 'GraphQL HTTP 503')).toContain('GraphQL HTTP 503');
    expect(fault('telemetry:tail_silent', 'No tail events')).not.toContain('No tail events');
  });

  it('falls back to plain words for a signal it has no copy for', () => {
    const { subject, text } = renderNotice(DEV, [row('new_thing:brand_new_signal', {})]);
    expect(subject).toBe('[dev] Something needs a look');
    expect(text).not.toContain('brand_new_signal');
    expect(text).toContain('docs/incidents.md');
  });
});

describe('the model guess', () => {
  const samples = [{ name: 'Error', message: 'out of memory' }];
  const withCause = (cause: string, extra: Partial<FindingRow> & { samples?: unknown[] } = {}) =>
    row(
      'api_worker:exceptions',
      { exceptions: 3 },
      {
        narrative: narrative(cause),
        narrative_status: 'written',
        samples,
        level: 'digest',
        ...extra,
      },
    );

  it('is labelled as a guess, and the rest of the model prose stays out', () => {
    const { text, html } = renderNotice(DEV, [withCause('The request hit the memory limit.')]);
    expect(text).toContain('A guess, unchecked: The request hit the memory limit.');
    expect(html).toContain('A guess, unchecked:');
    expect(`${text}${html}`).not.toMatch(/Likely cause|Model title|Model prose|Model next check/);
  });

  it('never appears without log text behind it: the false alarm named a missing route', () => {
    const f = withCause('Health route missing', { samples: [] });
    expect(renderNotice(DEV, [f]).text).not.toContain('Health route missing');
  });

  it.each([
    ['unknown', 'unknown'],
    ['a hedge that says nothing', 'unknown - possibly upstream slowness'],
    ['long prose', `A cause ${'in many words '.repeat(20)}`],
    ['a link', 'See https://evil.example/fix for the cause'],
    ['a bare domain', 'Visit www.evil.example to fix it'],
    ['an internal name it cannot translate', 'The retries_per_message rule is high'],
  ])('leaves out %s', (_name, cause) => {
    expect(guess(withCause(cause))).toBeNull();
  });

  it('puts internal component names into plain words', () => {
    expect(guess(withCause('api_worker hit the memory limit.'))).toBe(
      'API hit the memory limit.',
    );
  });

  it('keeps it to one line, and escapes it: it is built from exception text', () => {
    const { text, html } = renderNotice(DEV, [withCause('A <b>bold</b>\nclaim & more')]);
    expect(text).toContain('A <b>bold</b> claim & more');
    expect(html).toContain('A &lt;b&gt;bold&lt;/b&gt; claim &amp; more');
    expect(html).not.toContain('<b>bold');
  });

  it('is left out where several findings make one item', () => {
    const f = withCause('One cause.');
    const g = { ...withCause('Another cause.'), dedup_key: 'api_worker:error_logs' };
    expect(renderNotice(DEV, [f, g]).text).not.toContain('A guess');
  });
});

describe('the HTML part', () => {
  it('is a whole document that follows the client theme, with no background or image', () => {
    const { html } = renderUrgent(DEV, dead());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/background(-color)?:|<img/);
  });

  it('names the same facts as the plain part', () => {
    const { text, html } = renderUrgent(DEV, dead());
    for (const fact of ['1,066 background jobs failed', '1 Nov, 01:40 UTC', 'First:'])
      expect(text.includes(fact) && html.includes(fact)).toBe(true);
  });
});

describe('site', () => {
  it('reads the environment from the watched script', () => {
    expect(mailSite(testEnv())).toEqual(DEV);
    expect(
      mailSite(
        testEnv({
          WATCH_SCRIPT: 'yonedarepo-prod-platform',
          WATCH_URL: 'https://yonedarepo-prod-platform.example.workers.dev',
        }),
      ),
    ).toEqual({
      env: 'prod',
      site: 'https://yonedarepo.com',
      api: 'https://api.yonedarepo.com',
    });
  });
});

describe('copy', () => {
  const queue = {
    backlogLatest: 400,
    backlogEarliest: 5,
    lagMs: 300_000,
    retries: 3,
    deadLettered: 1,
    deadLetterBacklog: 1,
  };
  const everySignal = () => {
    const health = { ok: false, status: 503, latencyMs: 1 };
    const stats = {
      invocations: 100,
      errors: 50,
      exceptions: 9,
      resourceKills: 1,
      errorLogs: 9,
      pushRetries: 9,
      p95WallMs: 900,
      samples: [],
    };
    const tail = Object.fromEntries(
      [
        'api_worker',
        'source_repository',
        'check_runs',
        'derived_jobs',
        'land_queue',
        'commit_shards',
        'pack_builder',
        'ssh_gateway',
        'workspace_authority',
        'cron',
        'front_worker',
        'managed_worker',
      ].map((c) => [c, stats]),
    );
    const analytics = {
      window: { start: '', end: '' },
      objectKills: { source_repository: 1, check_runs: 1 },
      queue,
      checks: queue,
      managed: queue,
      containers: { maxDiskPercent: 90 },
    } as Analytics;
    const snapshot = {
      window: { start: '', end: '' },
      health,
      frontHealth: health,
      tail,
      marks: {},
      analytics,
      deadmanAge: 90,
      release: { revision: 'a', previous: 'b', after: tail, before: tail },
      delivery: { queue: 'q', gapMs: 70_700, waiting: 3, waitedMs: 48_000 },
    } as Snapshot;
    return evaluate(snapshot, {}, true).flatMap((r) =>
      r.signals.map((s) => [r.component, s.name] as const),
    );
  };

  it('covers every signal the watcher can raise, so no raw name reaches a mail', () => {
    const missing = [...new Set(everySignal().map(([, name]) => name))].filter(
      (name) => !COPY.some((c) => c.signals.includes(name)),
    );
    expect(missing).toEqual([]);
    expect(Object.keys(TELEMETRY_COPY).sort()).toEqual([
      'config',
      'disabled',
      'fetch_failed',
      'tail_silent',
      'token_missing',
    ]);
  });

  it('renders every signal on every component without a raw name or a blank', () => {
    for (const [component, name] of everySignal()) {
      const { subject, text } = renderNotice(DEV, [
        row(`${component}:${name}`, { [name]: 7 }, { level: 'digest' }),
      ]);
      // Log events are search terms the reader needs; signal and component keys are not.
      const words = `${subject}\n${text}`.replace(/[\w*]+\.[\w.]+/g, '');
      expect(words, `${component}:${name}`).not.toMatch(
        /undefined|null|NaN|[a-z]+_[a-z]+|Something needs a look/,
      );
    }
  });

  it('keeps to the UI rules: short lines and no internal names', () => {
    const lines = [...COPY, ...Object.values(TELEMETRY_COPY)].flatMap((c) => [
      c.first,
      ...(typeof c.means === 'string' ? [c.means] : []),
    ]);
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(76);
      expect(line, line).not.toMatch(/ledger|rollup|projection|derive|outbox|Durable Object/i);
    }
  });
});

describe('SSH gateway lifecycle alerts', () => {
  it('identifies gateway checks and alarms without claiming Git transfers failed', () => {
    const finding = row('ssh_gateway:error_rate', { error_rate: 0.0213 }, {
      signals: { signals: [{ name: 'error_rate', value: 0.0213, anomalous: true }], exception_samples: [{ name: 'Error', message: 'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.' }] },
    });
    const mail = renderNotice({ ...DEV, env: 'prod' }, [finding]);
    expect(mail.subject).toBe('[prod] 2.1% of SSH gateway checks failing');
    expect(mail.text).toContain('Gateway checks include keep-alive calls and housekeeping alarms.');
    expect(mail.text).toContain('Check alarm and container logs, then try a fresh SSH clone.');
    expect(mail.text).not.toContain('of SSH calls failing');
    // Reporting retains the original failure rate and finding identity.
    expect(finding.dedup_key).toBe('ssh_gateway:error_rate');
    expect((finding.signals as { signals: { value: number }[] }).signals[0].value).toBe(0.0213);
  });
});

describe('latency alert actions', () => {
  it('retains production latency evidence and asks for measured routes without guessing a dev cause', () => {
    const finding = row('front_worker:p95_wall_ms', { p95_wall_ms: 2189 }, {
      signals: { signals: [{ name: 'p95_wall_ms', value: 2189, baseline: 117, anomalous: true }] },
    });
    const mail = renderNotice({ ...DEV, env: 'prod' }, [finding]);
    expect(mail.subject).toBe('[prod] Website execution time rose');
    expect(mail.text).toContain('Estimated 95th percentile: 2.2 s; usual estimate 117 ms.');
    expect(mail.text).toContain('Includes background work.');
    expect(mail.text).toContain("First: Inspect request timings and upstream calls in this Worker's logs.");
    expect(mail.text).not.toContain('A burst on dev explains most.');
  });
});
