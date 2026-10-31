// New findings, by private email through Resend: after each pass, one digest of the open findings
// not mailed yet. A finding's details never go anywhere public; the ship's monitor reads only
// counts. A digest counts against DAILY_EMAIL_CAP (model spend has its own cap in the ledger, and
// a finding that could not get a narrative is mailed with its summary). What the cap or a failed
// send holds back stays unmailed for the next pass. Resend's Idempotency-Key covers a send whose
// acknowledgment was lost.
import type { SuperfanEnv } from './config';
import type { FindingRow, SuperfanLedger } from './ledger';
import type { Finding } from './model';

const RESEND_EMAILS = 'https://api.resend.com/emails';
/** Digests per UTC day: an hourly pass plus a ship's polls, with a flapping rule bounded. */
export const DAILY_EMAIL_CAP = 8;
/** Findings in one digest; the rest go in the next. */
const LISTED = 20;

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

const failed = (detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ event: 'superfan.notice.failed', ...detail }));

/** Mails one digest of unmailed findings; returns how many it covered. Never throws on a send. */
export async function notifyFindings(
  env: SuperfanEnv,
  ledger: DurableObjectStub<SuperfanLedger>,
  now: number,
) {
  if (!noticesOn(env)) return 0;
  const findings = (await ledger.claimNotice(now, DAILY_EMAIL_CAP, LISTED)) as FindingRow[];
  if (!findings.length) return 0;
  const release = () => ledger.releaseNotice(now);
  let key: string | undefined;
  try {
    key = (await env.RESEND_API_KEY?.get())?.trim();
  } catch {
    // The store's error is not logged: only that the key could not be read.
  }
  if (!key) {
    failed({ reason: 'RESEND_API_KEY is empty or unreadable' });
    await release();
    return 0;
  }
  const covered = findings.map((f) => `${f.id}:${f.occurrences}`).join(',');
  let answer: Response;
  try {
    answer = await fetch(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': `superfan/${await digest(`${env.WATCH_SCRIPT}\n${covered}`)}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [env.ADMIN_NOTIFY_EMAIL],
        ...renderNotice(env.WATCH_SCRIPT, findings),
      }),
    });
  } catch {
    failed({ reason: 'send failed' });
    await release();
    return 0;
  }
  if (!answer.ok) {
    failed({ status: answer.status });
    await release();
    return 0;
  }
  await ledger.markNotified(
    findings.map((f) => f.id),
    now,
  );
  return findings.length;
}
