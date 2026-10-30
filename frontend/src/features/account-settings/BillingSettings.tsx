// Settings → Billing: the account's agent credit, its card (brand and last four only; adding
// or replacing one is Stripe's own page), the automatic top-up rule and the top-ups it
// charged, and agent usage by repository and agent. Platform features are free; only
// managed agent runs use credit. Back from Stripe (`?billing=added`), the page re-reads until
// the card shows, since the webhook that records it can land a moment later.
import { useEffect, useState } from 'react';
import type { BillingState } from '../../../../shared/managed-agents';
import { loadState } from '../agents/agentParts';
import { agentName, billingPath, formatCost, usageTotals } from '../agents/agentsModel';
import {
  cardLabel,
  cardSaveState,
  topUpDay,
  topUpFailedText,
  topUpRule,
  topUpStatusLabel,
  topUpTone,
} from '../agents/billingModel';
import { AddCardButton, RemoveCardButton } from '../agents/billingParts';
import { useSource } from '../source-platform/useSource';

const returnedFromStripe = () =>
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('billing') === 'added';

export function BillingSettings({ workspace }: { workspace: string }) {
  const loaded = useSource<BillingState>(billingPath(workspace), '/api/managed');
  const [override, setOverride] = useState<BillingState | null>(null);
  const [tries, setTries] = useState(0);
  // Only a complete answer is drawn (an older managed Worker may lack a field).
  const answer = override ?? loaded.data;
  const billing = answer?.credit && Array.isArray(answer.usage) ? answer : undefined;
  const card = billing?.payment_method ?? null;
  const saving = cardSaveState(returnedFromStripe(), card, tries);
  const reload = loaded.reload;
  useEffect(() => {
    if (saving !== 'waiting' || loaded.loading) return;
    const timer = setTimeout(() => {
      setTries((n) => n + 1);
      reload();
    }, 2000);
    return () => clearTimeout(timer);
  }, [saving, loaded.loading, reload]);
  const totals = billing ? usageTotals(billing) : null;
  return (
    <section aria-labelledby="billing-heading" className="billing-settings">
      <h2 id="billing-heading">Billing</h2>
      <p className="source-meta">
        Every platform feature is free. Managed agent runs are paid for from your credit: their
        model calls at the provider&apos;s rate plus 30%, and their container time.
      </p>
      {loadState(loaded, 'billing') ??
        (billing && totals && (
          <>
            {saving === 'saved' && (
              <p className="billing-saved" role="status">
                Card saved.
              </p>
            )}
            {saving === 'waiting' && (
              <p className="source-meta" role="status">
                Saving your card…
              </p>
            )}
            {saving === 'late' && (
              <p className="source-meta" role="status">
                Stripe has not confirmed the card yet. Reload this page in a minute.
              </p>
            )}
            {billing.credit.top_up_failed && (
              <div className="billing-banner" role="alert">
                {topUpFailedText(billing.credit.top_up_failed)}
              </div>
            )}
            <div className="billing-cards">
              <div className="agent-card">
                <h3>Credit balance</h3>
                <p className="managed-figure">{formatCost(billing.credit.balance_usd)}</p>
                <p className="source-meta">
                  {formatCost(billing.credit.granted_usd)} of credit added so far, including the
                  starting credit added when you set up your first agent.{' '}
                  {formatCost(billing.credit.used_usd)} used.
                </p>
                {!billing.credit.promo.granted && (
                  <p className="source-meta">
                    Adding a card unlocks {formatCost(billing.credit.promo.usd)} of promotional
                    credit.
                  </p>
                )}
                {billing.credit.paused && (
                  <p className="managed-paused" role="status">
                    The credit is used up, so agent runs are paused until credit is added.
                  </p>
                )}
              </div>
              <div className="agent-card">
                <h3>Payment method</h3>
                {card ? (
                  <>
                    <p className="billing-card-label">{cardLabel(card)}</p>
                    <p className="source-meta">{topUpRule(billing.auto_top_up)}.</p>
                    <div className="agent-card-actions">
                      <AddCardButton
                        workspace={workspace}
                        billing={billing.billing}
                        label="Replace card"
                        className="quiet"
                      />
                      <RemoveCardButton
                        workspace={workspace}
                        card={card}
                        onRemoved={(next) => setOverride(next)}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <p>No card on file.</p>
                    <p className="source-meta">
                      {billing.billing === 'stripe'
                        ? 'Add a card to unlock the promotional credit, create your own agents and top up automatically.'
                        : 'Card billing is coming. Until then, the agents YonedaRepo maintains run on your starting credit.'}
                    </p>
                    <div className="agent-card-actions">
                      <AddCardButton workspace={workspace} billing={billing.billing} />
                    </div>
                  </>
                )}
              </div>
            </div>
            <h3>Top-ups</h3>
            {billing.top_ups.length ? (
              <div className="source-table-wrap">
                <table className="source-table">
                  <thead>
                    <tr>
                      <th>Date (UTC)</th>
                      <th>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.top_ups.map((t) => (
                      <tr key={t.id}>
                        <td>{topUpDay(t.created_at)}</td>
                        <td>{formatCost(t.amount_usd)}</td>
                        <td>
                          <span className={`chip run-${topUpTone(t.status)}`}>
                            {topUpStatusLabel(t.status)}
                          </span>
                          {t.error && <span className="source-meta"> {t.error}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="source-empty">No top-ups yet.</p>
            )}
            <h3>Usage by repository and agent</h3>
            {billing.usage.length ? (
              <div className="source-table-wrap">
                <table className="source-table">
                  <thead>
                    <tr>
                      <th>Repository</th>
                      <th>Agent</th>
                      <th>Runs</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.usage.map((u) => (
                      <tr key={`${u.repo}:${u.agent}`}>
                        <td>{u.repo_name}</td>
                        <td>{agentName(u.agent)}</td>
                        <td>{u.runs}</td>
                        <td>{formatCost(u.cost_usd)}</td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" colSpan={2}>
                        Total
                      </th>
                      <td>{totals.runs}</td>
                      <td>{formatCost(totals.cost_usd)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="source-empty">No agent has run yet, so nothing has been used.</p>
            )}
          </>
        ))}
    </section>
  );
}
