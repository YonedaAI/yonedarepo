// Browser gate, managed agents (part of kit item `browser`): Browse → Agents shows "Managed by
// YonedaRepo" with the promotional credit card and one card per maintained agent (Code review,
// Security review, Slop review), each with Enable; New agent waits for billing. Enable opens
// that agent's settings page pre-filled with the maintained defaults and the Repositories
// checklist, without enabling anything (enabling would mint a token and webhook on the kit's
// repository and start paid runs). View runs and Settings → Billing render. Read-only.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';

const AGENTS = ['Code review', 'Security review', 'Slop review'];

export async function managedAgentPages(page, { repo: { name }, shot }, m) {
  await page.getByRole('navigation', { name: 'Browse' }).getByRole('link', { name: 'Agents', exact: true }).click();
  await page.waitForURL('**/agents');
  await see(page.getByRole('heading', { name: 'Managed by YonedaRepo' }), 'the Agents overview heading');
  await see(page.getByRole('heading', { name: 'This one is on us!' }), 'the promotional credit card');
  for (const agent of AGENTS) {
    const card = page.locator('section.agent-card').filter({ has: page.getByRole('heading', { name: agent, exact: true }) });
    await see(card, `the ${agent} card`);
    assert.equal(
      (await card.getByRole('link', { name: 'Enable' }).count()) + (await card.getByRole('link', { name: 'Edit' }).count()),
      1,
      `${agent} offers Enable (or Edit once enabled)`,
    );
  }
  await see(page.getByRole('link', { name: 'View runs' }), 'View runs');
  await see(page.getByRole('link', { name: 'New agent' }), 'New agent');
  await shot('agents-overview');

  const code = page.locator('section.agent-card').filter({ has: page.getByRole('heading', { name: 'Code review', exact: true }) });
  await code.getByRole('link', { name: /^(Enable|Edit)$/ }).click();
  await page.waitForURL('**/agents/code-review**');
  await see(page.getByRole('heading', { name: 'Code review', level: 1 }), 'the Code review settings page');
  await see(page.getByText(/maintained by YonedaRepo/), 'the maintained-defaults note');
  const repos = page.getByRole('group', { name: 'Repositories' });
  await see(repos.getByText(name), "the kit repository in the Repositories checklist");
  await see(page.getByRole('button', { name: /^(Enable agent|Save)$/ }), 'Enable agent (or Save)');
  await shot('agents-settings');

  await page.goto(new URL('/agents/runs', page.url()).toString());
  await see(page.getByRole('heading', { name: 'Runs', level: 1 }), 'the runs page');
  await shot('agents-runs');

  await page.goto(new URL('/agents/new', page.url()).toString());
  await see(page.getByRole('heading', { name: 'New agent', level: 1 }), 'the New agent page');
  await see(page.getByText(/billing/i).first(), 'the billing notice on New agent');

  await page.goto(new URL('/settings/billing', page.url()).toString());
  const billing = page.getByRole('region', { name: 'Billing' });
  await see(billing, 'Settings → Billing');
  await see(billing.getByText('No card on file.'), 'the payment method placeholder');
  await shot('account-billing');
  m.managed_agents = AGENTS.join(', ');
}
