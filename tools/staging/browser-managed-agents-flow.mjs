// Browser gate, managed agents (part of kit item `browser`): Browse → Agents shows "Managed by
// YonedaRepo" with the promotional credit card and one card per maintained agent (Code review,
// Security review, Slop review), each with Add agent (or Open once set up); New agent is off for now. Add agent opens
// that agent's page with the maintained defaults and the Repositories choice, without
// enabling anything (enabling would mint a token and webhook on the kit's
// repository and start paid runs). View runs and Settings → Billing render. Read-only.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';

const AGENTS = ['Code review', 'Security review', 'Slop review'];
// A card's action: Add agent until the agent is set up, Open after.
const ACTION = /^(Add agent|Open)$/;

export async function managedAgentPages(page, { repo: { name }, shot }, m) {
  await page.getByRole('navigation', { name: 'Browse' }).getByRole('link', { name: 'Agents', exact: true }).click();
  await page.waitForURL('**/agents');
  await see(page.getByRole('heading', { name: 'Managed by YonedaRepo' }), 'the Agents overview heading');
  await see(page.getByRole('heading', { name: 'This one is on us!' }), 'the promotional credit card');
  for (const agent of AGENTS) {
    const card = page.locator('section.agent-card').filter({ has: page.getByRole('heading', { name: agent, exact: true }) });
    await see(card, `the ${agent} card`);
    assert.equal(await card.locator('.agent-card-actions').getByRole('link', { name: ACTION }).count(), 1, `${agent} offers ${ACTION}`);
  }
  await see(page.getByRole('link', { name: 'View runs' }), 'View runs');
  await see(page.getByRole('button', { name: 'New agent' }), 'New agent');
  await shot('agents-overview');

  const code = page.locator('section.agent-card').filter({ has: page.getByRole('heading', { name: 'Code review', exact: true }) });
  await code.locator('.agent-card-actions').getByRole('link', { name: ACTION }).click();
  await page.waitForURL('**/agents/code-review**');
  await see(page.getByRole('heading', { name: /Code review$/, level: 1 }), 'the Code review settings page');
  await see(page.getByText(/YonedaRepo maintains this agent/), 'the maintained-defaults note');
  // Only the form changes here: nothing is submitted.
  await page.getByRole('radio', { name: 'Only the repositories I choose' }).check();
  await see(page.getByRole('group', { name: 'Chosen repositories' }).getByText(name), 'the kit repository in the Repositories checklist');
  await see(page.getByRole('button', { name: /^(Add agent|Save changes)$/ }), 'Add agent (or Save changes)');
  await shot('agents-settings');

  await page.goto(new URL('/agents/runs', page.url()).toString());
  await see(page.getByRole('heading', { name: 'Runs', level: 1 }), 'the runs page');
  await shot('agents-runs');

  await page.goto(new URL('/agents/new', page.url()).toString());
  await see(page.getByRole('heading', { name: 'New agent', level: 1 }), 'the New agent page');
  await see(page.getByText(/Creating your own agents is coming/).first(), 'the notice on New agent');

  await page.goto(new URL('/settings', page.url()).toString());
  const billing = page.getByRole('region', { name: 'Billing' });
  await see(billing, 'Settings → Billing');
  await see(billing.getByText('No card on file.'), 'the payment method placeholder');
  await shot('account-billing');
  m.managed_agents = AGENTS.join(', ');
}
