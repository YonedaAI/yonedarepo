// Membership notices use the existing durable platform queue and account mail sender.
import { log } from './log';
import { config, postEmail, resendKey } from './platform-welcome-email';
import { sha } from './storage';
import type { Env, Envelope } from './types';
import { workspace } from './workspace';

export async function memberNotificationJob(
  env: Env,
  envelope: Envelope,
  send: typeof fetch = fetch,
): Promise<{ retry?: number }> {
  const org = envelope.workspace;
  const id = envelope.number;
  if (!org || !Number.isSafeInteger(id) || (id ?? 0) < 1) return {};
  const command = (op: string, fields = {}) => workspace(env, org, { op, id, ...fields });
  const { notice } = await command('member_notice_claim');
  if (!notice) return {};
  const epoch = notice.epoch;
  const finish = (email_state: string) => command('member_notice_finish', { epoch, email_state });
  const recipient = notice.recipient;
  if (!(await workspace(env, recipient, { op: 'account_exists' })).exists) {
    await finish('skipped');
    return {};
  }
  await workspace(env, recipient, {
    op: 'notification_put',
    org,
    id,
    role: notice.role,
    at: notice.created_at,
  });
  const state = await workspace(env, recipient, { op: 'email_status' });
  if (!state.verified || typeof state.email !== 'string') {
    await finish('skipped');
    return {};
  }
  const settings = config(env);
  const key = settings && (await resendKey(env));
  if (!settings || !key) return { retry: 60 };
  if (!(await command('member_notice_mail_begin', { epoch })).allowed) {
    await finish('uncertain');
    return {};
  }
  const href = `${settings.origin}/orgs/${encodeURIComponent(org)}`;
  const title = `You joined ${org}`;
  const email = {
    subject: `${title} on YonedaRepo`,
    text: `${title}.\n\nOpen the organization: ${href}\n\nYonedaRepo`,
    // org is an authority-validated handle; the configured origin is never caller input.
    html: `<h1>${title}</h1><p><a href="${href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">Open organization</a></p><p>YonedaRepo</p>`,
  };
  const bounded: typeof fetch = (url, init) =>
    send(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const failure = await postEmail(
    bounded,
    key,
    settings,
    state.email,
    email,
    `org-member/${await sha(`${settings.origin}\n${org}\n${id}`)}`,
  );
  if (!failure) await finish('sent');
  else if (failure.transient) return { retry: 60 };
  else {
    await finish('failed');
    log.warn('org.member_email.failed', { status: failure.status });
  }
  return {};
}
