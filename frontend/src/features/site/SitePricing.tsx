// Pricing (`/pricing`): preview pricing from `pricing.ts`. Billing is not built, so nothing
// here can be bought yet and the page says so first.
import { Check } from 'lucide-react';
import { CONTAINER_USD_PER_MINUTE } from '../../../../shared/managed-agents';
import type { Navigate } from '../shell/useRoute';
import { agentUsageRows, formatUsd, MARGIN, METERS, meterPrice, PRICING } from './pricing';
import { siteLink } from './SiteLayout';

const FREE = [
  'Public and private repositories, organizations, teams and forks',
  'Git over HTTPS and SSH, the yoneda:: helper, the CLI and MCP',
  'Server-side commits, landing, merges and history at any version',
  'Changes, reviews, approvals and landing rules',
  'Code search, blame, history and Overview',
  'Agent sessions and repository context',
];

export function SitePricing({ navigate }: { navigate: Navigate }) {
  const margin = Math.round((MARGIN - 1) * 100);
  return (
    <article className="site-page site-pricing">
      <header className="site-page-head">
        <p className="site-badge">Preview pricing</p>
        <h1>Free platform. Pay only for what we run.</h1>
        <p className="site-lead">
          Every platform feature is free. Metered usage is billed at our provider's list cost plus{' '}
          {margin}%.
        </p>
        <p className="site-notice" role="note">
          Billing is not live yet. These are the rates we plan to charge; no account is billed today
          and there is nothing to buy on this page.
        </p>
      </header>

      <section aria-labelledby="free-heading" className="site-section">
        <h2 id="free-heading">Free: the whole platform</h2>
        <ul className="site-checklist">
          {FREE.map((item) => (
            <li key={item}>
              <Check size={16} aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="metered-heading" className="site-section">
        <h2 id="metered-heading">Metered: pay as you go</h2>
        <div className="site-table">
          <table>
            <caption>Metered rates per account</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Free each month</th>
                <th scope="col">Then</th>
                <th scope="col">Cost basis</th>
              </tr>
            </thead>
            <tbody>
              {METERS.map((meter) => (
                <tr key={meter.id}>
                  <th scope="row">
                    {meter.label}
                    <small>{meter.detail}</small>
                  </th>
                  <td>{meter.included ?? 'None (the starting credit covers it)'}</td>
                  <td className="site-rate">
                    {formatUsd(meterPrice(meter))} / {meter.unit}
                  </td>
                  <td>
                    {meter.basis}
                    <small>
                      {formatUsd(Number(meter.cost.toPrecision(4)))} / {meter.unit} × {MARGIN}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="agent-usage-heading" className="site-section">
        <h2 id="agent-usage-heading">Agent usage: pay as you go</h2>
        <p>
          The managed agents (code, security and slop review) are paid for by what each run uses:
          the tokens its model calls read and write, at the provider&apos;s list rate plus {margin}
          %, and the minutes its review container runs, at {formatUsd(CONTAINER_USD_PER_MINUTE)} a
          minute. Every platform feature stays free. Your first runs come out of the{' '}
          {formatUsd(PRICING.startingCreditUsd)} promotional credit, and agents pause at a $0
          balance until credit is added. Setting up billing is coming.
        </p>
        <div className="site-table">
          <table>
            <caption>Agent model rates, per million tokens</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Used by</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cost basis</th>
              </tr>
            </thead>
            <tbody>
              {agentUsageRows().map((row) => (
                <tr key={`${row.provider}/${row.model}`}>
                  <th scope="row">
                    {row.label}
                    <small>{row.model}</small>
                  </th>
                  <td>{row.agents.length ? row.agents.join(', ') : 'Available'}</td>
                  <td className="site-rate">{formatUsd(row.input_price)}</td>
                  <td className="site-rate">{formatUsd(row.output_price)}</td>
                  <td>
                    Provider list rate, read {row.verified_at}
                    <small>
                      {formatUsd(row.input)} in / {formatUsd(row.output)} out × {MARGIN}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="balance-heading" className="site-section site-cards">
        <h2 id="balance-heading">Your balance</h2>
        <div className="site-card">
          <h3>Starting credit</h3>
          <p className="site-figure">{formatUsd(PRICING.startingCreditUsd)}</p>
          <p>On every new account. No card required.</p>
        </div>
        <div className="site-card">
          <h3>Automatic top-up</h3>
          <p className="site-figure">
            {formatUsd(PRICING.topUp.addUsd)} below {formatUsd(PRICING.topUp.belowUsd)}
          </p>
          <p>
            Once a card is added, the balance tops up by {formatUsd(PRICING.topUp.addUsd)} when it
            falls below {formatUsd(PRICING.topUp.belowUsd)}.
          </p>
        </div>
        <div className="site-card">
          <h3>Pauses at $0</h3>
          <p className="site-figure">No surprise bills</p>
          <p>
            At a zero balance metered work pauses: new checks and agent runs wait, and storage or
            egress past the free allowance stops growing until you top up. Nothing is deleted.
          </p>
        </div>
      </section>

      <section aria-labelledby="enterprise-heading" className="site-section site-enterprise">
        <h2 id="enterprise-heading">Enterprise</h2>
        <p>
          For custom terms, Enterprise is by contact. Email{' '}
          <a href={PRICING.enterpriseContact}>
            {PRICING.enterpriseContact.replace(/^mailto:/, '')}
          </a>
          .
        </p>
        <p>
          <a className="site-button" {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}>
            Get started free
          </a>
        </p>
      </section>
    </article>
  );
}
