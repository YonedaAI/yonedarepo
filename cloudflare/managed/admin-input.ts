// What an operator's billing action must carry. The platform Worker checks the operator and
// scans the reason with the platform's own rules; these are the managed Worker's own checks of
// the same body, since it holds the money.
import { BillingRefusal } from './billing';
import { looksLikeCredential } from './sanitize';

const REASON_MAX = 500;
const ID = /^[A-Za-z0-9-]{8,64}$/;

const invalid = (message: string) => new BillingRefusal('INVALID_INPUT', message, 400);

export function reasonOf(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw invalid('A reason is required');
  if (reason.length > REASON_MAX) throw invalid(`A reason is at most ${REASON_MAX} characters`);
  if (looksLikeCredential(reason))
    throw new BillingRefusal(
      'SECRET_DETECTED',
      'That reason looks like it holds a credential',
      422,
    );
  return reason;
}

export function actorOf(body: Record<string, unknown>): string {
  const actor = typeof body.actor === 'string' ? body.actor.trim() : '';
  if (!actor || actor.length > 128) throw invalid('Who is acting is required');
  return actor;
}

/** The caller's idempotency id: the same one again is the same action. */
export function idOf(body: Record<string, unknown>): string {
  if (typeof body.id !== 'string' || !ID.test(body.id)) throw invalid('id is required');
  return body.id;
}

/** A positive amount in whole cents, as micro-USD. */
export function microOf(value: unknown): number {
  const cents = Number(value) * 100;
  const whole = Math.round(cents);
  if (typeof value !== 'number' || !Number.isSafeInteger(whole) || whole <= 0)
    throw invalid('usd must be a positive amount');
  if (Math.abs(cents - whole) > 1e-6) throw invalid('usd must be in whole cents');
  return whole * 10_000;
}
