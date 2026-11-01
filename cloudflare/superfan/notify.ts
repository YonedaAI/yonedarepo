// New findings, by private email through Resend: after each pass, one digest of the open findings
// not mailed yet. A finding's details never go anywhere public; the ship's monitor reads only
// counts. A digest counts against DAILY_EMAIL_CAP (model spend has its own cap in the ledger, and
// a finding that could not get a narrative is mailed with its summary). What the cap or a failed
// send holds back stays unmailed for the next pass. Urgent findings go first and alone, as soon as
// a pass sees them: no digest carries one and the cap never holds one, and each signal has its own
// limit (ledger-notice.ts). Resend's Idempotency-Key covers a send whose acknowledgment was lost.
import type { SuperfanEnv } from './config';
import type { FindingRow, SuperfanLedger } from './ledger';
import type { Finding } from './model';

const RESEND_EMAILS = 'https://api.resend.com/emails';
/** Digests per UTC day: an hourly pass plus a ship's polls, with a flapping rule bounded. */
export const DAILY_EMAIL_CAP = 8;
/** Findings in one digest; the rest go in the next. */
const LISTED = 20;
const INCIDENTS = 'docs/incidents.md has the first check for each signal.';

export const noticesOn = (env: SuperfanEnv) =>
  Boolean(env.ADMIN_NOTIFY_EMAIL?.trim() && env.EMAIL_FROM?.trim() && env.RESEND_API_KEY);

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function line(f: FindingRow) {
  const narrative = f.narrative as Finding | null;
  return [
    `#${f.id} ${f.component} (${f.kind}), first seen ${f.first_seen}, seen ${f.occurrences}x`,
    `  ${narrative?.title ?? f.summary}`,
    ...(narrative
      ? [
          `  ${narrative.what}`,
          `  Evidence: ${narrative.evidence}`,
          `  Likely cause: ${narrative.likely_cause}`,
          `  Next: ${narrative.next_check}`,
        ]
      : []),
  ].join('\n');
}

export function renderNotice(script: string, findings: FindingRow[]) {
  const count = `${findings.length} new finding${findings.length === 1 ? '' : 's'}`;
  return {
    subject: `[${script}] ${count}`,
    text: `${count} on ${script}. GET /findings on Superfan has the signals.\n\n${findings.map(line).join('\n\n')}\n`,
  };
}

export function renderUrgent(script: string, findings: FindingRow[]) {
  const [first, ...rest] = findings;
  const more = rest.length ? ` +${rest.length} more` : '';
  return {
    subject: `[URGENT ${script}] ${first.dedup_key.replace(':', ' ')}${more}`,
    text: `Urgent on ${script}. ${INCIDENTS}\n\n${findings.map(line).join('\n\n')}\n`,
  };
}

const failed = (detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ event: 'superfan.notice.failed', ...detail }));

/** One email to the owner; true once Resend took it. Never throws, and logs no key. */
async function send(
  env: SuperfanEnv,
  idempotency: string,
  mail: { subject: string; text: string },
) {
  let key: string | undefined;
  try {
    key = (await env.RESEND_API_KEY?.get())?.trim();
  } catch {
    // The store's error is not logged: only that the key could not be read.
  }
  if (!key) {
    failed({ reason: 'RESEND_API_KEY is empty or unreadable' });
    return false;
  }
  let answer: Response;
  try {
    answer = await fetch(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': `superfan/${await digest(`${env.WATCH_SCRIPT}\n${idempotency}`)}`,
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.ADMIN_NOTIFY_EMAIL], ...mail }),
    });
  } catch {
    failed({ reason: 'send failed' });
    return false;
  }
  if (!answer.ok) failed({ status: answer.status });
  return answer.ok;
}

/** Mails one digest of unmailed findings; returns how many it covered. Never throws on a send. */
export async function notifyFindings(
  env: SuperfanEnv,
  ledger: DurableObjectStub<SuperfanLedger>,
  now: number,
) {
  if (!noticesOn(env)) return 0;
  const findings = (await ledger.claimNotice(now, DAILY_EMAIL_CAP, LISTED)) as FindingRow[];
  if (!findings.length) return 0;
  const covered = findings.map((f) => `${f.id}:${f.occurrences}`).join(',');
  if (!(await send(env, covered, renderNotice(env.WATCH_SCRIPT, findings)))) {
    await ledger.releaseNotice(now);
    return 0;
  }
  await ledger.markNotified(
    findings.map((f) => f.id),
    now,
  );
  return findings.length;
}

/** Mails the urgent findings whose signals may mail now, in one email; returns how many. */
export async function notifyUrgent(
  env: SuperfanEnv,
  ledger: DurableObjectStub<SuperfanLedger>,
  now: number,
) {
  if (!noticesOn(env)) return 0;
  const findings = (await ledger.claimUrgent(now, LISTED)) as (FindingRow & { seq: number })[];
  if (!findings.length) return 0;
  // A signal's mail number for the day: a retry repeats it, the next mail does not.
  const turn = findings.map((f) => `${f.dedup_key}:${f.seq}`).join(',');
  const key = `urgent\n${new Date(now).toISOString().slice(0, 10)}\n${turn}`;
  if (!(await send(env, key, renderUrgent(env.WATCH_SCRIPT, findings)))) {
    await ledger.releaseUrgent(findings.map((f) => f.dedup_key));
    return 0;
  }
  await ledger.markNotified(
    findings.map((f) => f.id),
    now,
  );
  return findings.length;
}
