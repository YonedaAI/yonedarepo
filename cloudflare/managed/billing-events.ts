// Stripe's events for operators' billing, verified by the webhook before they reach here. A
// `charge.refunded` carries the running total refunded and no list of refunds (Stripe leaves
// `refunds` off a charge by default), so the ledger compares totals: what it cannot account for
// was refunded in Stripe's dashboard. A dispute carries none of our metadata, so its charge is
// read to find the workspace and top-up. Off without ADMIN_BILLING.
import type { ManagedEnv, QueueMessage } from './config';
import { ledgerStub, type Paused } from './ledger';
import { chargeOf } from './stripe-admin';

export type OperatorEvent = { recorded: boolean; resume: Paused[] };

const IGNORED: OperatorEvent = { recorded: false, resume: [] };

async function refunded(env: ManagedEnv, charge: Record<string, any>): Promise<OperatorEvent> {
  const account = charge.metadata?.workspace;
  const topUp = charge.metadata?.top_up;
  const total = Number(charge.amount_refunded);
  if (typeof account !== 'string' || typeof topUp !== 'string' || !Number.isSafeInteger(total))
    return IGNORED;
  const open = await ledgerStub(env, account).stripeRefunded(topUp, total * 10_000);
  if (open?.length)
    await env.RUNS.sendBatch(
      open.map((id) => ({ body: { kind: 'refund', account, id } as QueueMessage })),
    );
  return { recorded: open !== null, resume: [] };
}

async function disputed(
  env: ManagedEnv,
  dispute: Record<string, any>,
  closed: boolean,
): Promise<OperatorEvent> {
  const charge = await chargeOf(env, String(dispute.charge));
  const account = charge?.metadata?.workspace;
  const topUp = charge?.metadata?.top_up;
  if (typeof account !== 'string' || typeof topUp !== 'string') return IGNORED;
  const event = {
    id: String(dispute.id),
    top_up: topUp,
    charge: String(dispute.charge),
    amount: Number(dispute.amount) * 10_000,
    reason: typeof dispute.reason === 'string' ? dispute.reason.slice(0, 80) : null,
  };
  const ledger = ledgerStub(env, account);
  if (closed) {
    const { resume } = await ledger.disputeClosed(event, String(dispute.status));
    return { recorded: true, resume };
  }
  await ledger.disputeOpened(event);
  return { recorded: true, resume: [] };
}

/** What became of an event operators' billing handles; undefined for any other event. */
export async function operatorEvent(
  env: ManagedEnv,
  event: Record<string, any>,
): Promise<OperatorEvent | undefined> {
  if (env.ADMIN_BILLING !== 'on') return undefined;
  const object = event.data?.object ?? {};
  if (event.type === 'charge.refunded') return refunded(env, object);
  if (event.type === 'charge.dispute.created') return disputed(env, object, false);
  if (event.type === 'charge.dispute.closed') return disputed(env, object, true);
  return undefined;
}
