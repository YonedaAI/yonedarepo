// The Agents overview's credit card. Without a card: the starting credit (added when the first
// agent is set up) and an offer to unlock the promotional credit by adding a card. With one:
// the balance, the card (brand and last four only), whether automatic top-up is on, and a link
// to Settings → Billing (`manageHref`, where that is this workspace's billing). Back from
// Stripe, whether the card was saved.
import type { BillingMode, ManagedCredit } from '../../../../shared/managed-agents';
import { creditPercent, formatCost, usedText } from './agentsModel';
import { type CardSaveState, cardSummary, promoCopy } from './billingModel';
import { AddCardButton, CardSaveNotice } from './billingParts';

export function PromoCard({
  workspace,
  credit,
  billing,
  returnTo,
  manageHref,
  saving = 'none',
}: {
  workspace: string;
  credit: ManagedCredit;
  billing: BillingMode;
  /** Where Stripe sends the browser back once a card is saved. */
  returnTo?: string;
  manageHref?: string;
  saving?: CardSaveState;
}) {
  const copy = promoCopy(credit, billing);
  return (
    <section className="agent-card agent-promo" aria-labelledby="promo-heading">
      <h3 id="promo-heading">{copy.title}</h3>
      <CardSaveNotice saving={saving} credit={credit} />
      <p>{copy.body}</p>
      {credit.card && (
        <p className="managed-figure">
          <span className="sr-only">Balance </span>
          {formatCost(credit.balance_usd)}
        </p>
      )}
      <div className="agent-usage">
        <div className="managed-meter" aria-hidden="true">
          <span
            style={{ width: `${creditPercent(credit)}%` }}
            className={credit.paused ? 'spent' : undefined}
          />
        </div>
        <span>{usedText(credit)}</span>
      </div>
      {credit.top_up_failed && (
        <p className="managed-paused" role="status">
          The last top-up failed. Runs stop when your credit runs out; update your card in Settings.
        </p>
      )}
      {credit.paused && !credit.top_up_failed && (
        <p className="managed-paused" role="status">
          The credit is used up, so runs are paused until credit is added.
        </p>
      )}
      {credit.card ? (
        <p className="source-meta">
          {cardSummary(credit)}
          {manageHref && (
            <>
              {' · '}
              <a href={manageHref}>Manage billing</a>
            </>
          )}
        </p>
      ) : (
        <div className="agent-card-actions">
          <AddCardButton
            workspace={workspace}
            billing={billing}
            label={copy.action}
            returnTo={returnTo}
          />
        </div>
      )}
    </section>
  );
}
