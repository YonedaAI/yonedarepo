// Settings → Billing (`/settings/billing`), a headed card each: the account's agent credit, its
// payment method (brand and last four only; adding or replacing one is Stripe's own page), the
// automatic top-up switch and rule, how to stop paying, the top-ups it charged, and agent usage
// by repository and agent. Managed agent runs use credit.
import { useState } from 'react';
import type { BillingState } from '../../../../shared/managed-agents';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import { loadState } from '../agents/agentParts';
import { agentName, billingPath, formatCost, usageTotals } from '../agents/agentsModel';
import {
  cardLabel,
  topUpDay,
  topUpFailedText,
  topUpRule,
  topUpStatusLabel,
  topUpTone,
} from '../agents/billingModel';
import {
  AddCardButton,
  AutoTopUpSwitch,
  CardSaveNotice,
  RemoveCardButton,
  useCardReturn,
} from '../agents/billingParts';
import { useSource } from '../source-platform/useSource';

export function BillingSettings({ workspace }: { workspace: string }) {
  const loaded = useSource<BillingState>(billingPath(workspace), '/api/managed');
  const [override, setOverride] = useState<BillingState | null>(null);
  // Only a complete answer is drawn (an older managed Worker may lack a field).
  const answer = override ?? loaded.data;
  const billing = answer?.credit && Array.isArray(answer.usage) ? answer : undefined;
  const card = billing?.payment_method ?? null;
  const saving = useCardReturn(card, loaded.loading, loaded.reload);
  const totals = billing ? usageTotals(billing) : null;
  // Without a card, the promotion's prompt holds Add a card; Payment method holds it otherwise.
  const offerPromo = !card && billing?.credit.promo.granted === false;
  return (
    <>
      <p className="source-meta">Managed agent runs use your credit.</p>
      {loadState(loaded, 'billing') ??
        (billing && totals && (
          <>
            <CardSaveNotice saving={saving} credit={billing.credit} />
            {billing.credit.top_up_failed && (
              <div className="billing-banner" role="alert">
                {topUpFailedText(billing.credit.top_up_failed)}
              </div>
            )}
            <SettingsSection id="credit" title="Credit balance">
              <SettingsRow
                title={
                  <span className="managed-figure">{formatCost(billing.credit.balance_usd)}</span>
                }
                detail={
                  <>
                    {formatCost(billing.credit.granted_usd)} added so far,{' '}
                    {formatCost(billing.credit.used_usd)} used.
                  </>
                }
              />
              {billing.credit.paused && (
                <div className="settings-block">
                  <p className="managed-paused" role="status">
                    The credit is used up, so agent runs are paused until credit is added.
                  </p>
                </div>
              )}
              {offerPromo && (
                <SettingsRow
                  title={`Adding a card unlocks ${formatCost(billing.credit.promo.usd)} of promotional credit.`}
                  action={<AddCardButton workspace={workspace} billing={billing.billing} />}
                />
              )}
            </SettingsSection>
            <SettingsSection id="payment" title="Payment method">
              {card ? (
                <>
                  <SettingsRow
                    title={<span className="billing-card-label">{cardLabel(card)}</span>}
                    action={
                      <>
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
                      </>
                    }
                  />
                  <SettingsRow
                    title={
                      <AutoTopUpSwitch
                        workspace={workspace}
                        enabled={billing.auto_top_up.enabled}
                        onChange={(next) => setOverride(next)}
                      />
                    }
                    detail={
                      billing.auto_top_up.enabled
                        ? `${topUpRule(billing.auto_top_up)}.`
                        : 'Your card is not charged. Runs pause when your credit runs out.'
                    }
                  />
                  <p className="source-meta settings-block">
                    To stop all charges: turn off automatic top-up or remove your card. Agents keep
                    running on your remaining credit, then pause. Pause or archive agents on the
                    Agents page.
                  </p>
                </>
              ) : (
                <SettingsRow
                  title="No card on file."
                  detail={
                    billing.billing === 'stripe'
                      ? 'Add a card to unlock the promotional credit and top up automatically.'
                      : 'Card billing is coming. Until then, agents run on your starting credit.'
                  }
                  action={
                    !offerPromo && <AddCardButton workspace={workspace} billing={billing.billing} />
                  }
                />
              )}
            </SettingsSection>
            <SettingsSection id="top-ups" title="Top-ups">
              {billing.top_ups.length ? (
                <div className="source-table-wrap">
                  <table className="source-table">
                    <thead>
                      <tr>
                        <th>Date (UTC)</th>
                        <th className="num">Amount</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {billing.top_ups.map((t) => (
                        <tr key={t.id}>
                          <td>{topUpDay(t.created_at)}</td>
                          <td className="num">{formatCost(t.amount_usd)}</td>
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
            </SettingsSection>
            <SettingsSection id="usage" title="Usage by repository and agent">
              {billing.usage.length ? (
                <div className="source-table-wrap">
                  <table className="source-table">
                    <thead>
                      <tr>
                        <th>Repository</th>
                        <th>Agent</th>
                        <th className="num">Runs</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {billing.usage.map((u) => (
                        <tr key={`${u.repo}:${u.agent}`}>
                          <td>{u.repo_name}</td>
                          <td>{agentName(u.agent)}</td>
                          <td className="num">{u.runs}</td>
                          <td className="num">{formatCost(u.cost_usd)}</td>
                        </tr>
                      ))}
                      <tr className="total">
                        <th scope="row" colSpan={2}>
                          Total
                        </th>
                        <td className="num">{totals.runs}</td>
                        <td className="num">{formatCost(totals.cost_usd)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="source-empty">No agent has run yet.</p>
              )}
            </SettingsSection>
          </>
        ))}
    </>
  );
}
