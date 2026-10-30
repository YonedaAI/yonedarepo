// Settings → Billing: the account's agent credit (the starting credit added when its first
// agent is set up), its payment method (none yet: setting up billing is coming) and agent usage by
// repository and agent. Platform features are free; only managed agent runs use credit.
import type { BillingState } from '../../../../shared/managed-agents';
import { BillingComing, loadState } from '../agents/agentParts';
import { agentName, billingPath, formatCost, usageTotals } from '../agents/agentsModel';
import { useSource } from '../source-platform/useSource';

export function BillingSettings({ workspace }: { workspace: string }) {
  const loaded = useSource<BillingState>(billingPath(workspace), '/api/managed');
  // Only a complete answer is drawn (an older managed Worker may lack a field).
  const billing = loaded.data?.credit && Array.isArray(loaded.data.usage) ? loaded.data : undefined;
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
            <div className="billing-cards">
              <div className="agent-card">
                <h3>Credit balance</h3>
                <p className="managed-figure">{formatCost(billing.credit.balance_usd)}</p>
                <p className="source-meta">
                  Starting credit is added when you set up your first agent:{' '}
                  {formatCost(billing.credit.granted_usd)}. {formatCost(billing.credit.used_usd)}{' '}
                  used.
                </p>
                {billing.credit.paused && (
                  <p className="managed-paused" role="status">
                    The credit is used up, so agent runs are paused until credit is added.
                  </p>
                )}
              </div>
              <div className="agent-card">
                <h3>Payment method</h3>
                <p>No card on file.</p>
                <BillingComing>Setting up billing is coming.</BillingComing>
              </div>
            </div>
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
