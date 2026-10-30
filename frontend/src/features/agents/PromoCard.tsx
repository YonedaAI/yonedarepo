// The Agents overview's credit card. Without a card: the starting credit (added when the first
// agent is set up) and an offer to unlock the promotional credit by adding a card. With one:
// the balance, the automatic top-up rule and the card (brand and last four only).
import type { BillingMode, ManagedCredit } from '../../../../shared/managed-agents';
import { AUTO_TOP_UP } from '../../../../shared/managed-agents';
import { creditPercent, formatCost, usedText } from './agentsModel';
import { cardLabel, promoCopy, topUpRule } from './billingModel';
import { AddCardButton } from './billingParts';

export function PromoCard({
  workspace,
  credit,
  billing,
}: {
  workspace: string;
  credit: ManagedCredit;
  billing: BillingMode;
}) {
  const copy = promoCopy(credit, billing);
  return (
    <section className="agent-card agent-promo" aria-labelledby="promo-heading">
      <h3 id="promo-heading">{copy.title}</h3>
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
          {topUpRule(AUTO_TOP_UP)} · {cardLabel(credit.card)}
        </p>
      ) : (
        <div className="agent-card-actions">
          <AddCardButton workspace={workspace} billing={billing} label={copy.action} />
        </div>
      )}
    </section>
  );
}
