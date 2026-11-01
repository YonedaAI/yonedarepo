// This week's features as kit items (33-44), no model: CTC, Landings, flight plan and go-around,
// search across repositories, the Clone panel, admin Revenue and Traffic, org delete during
// create, the audit log, the empty states and the whole Flight Path, by API, CLI, Git, MCP and in
// Chrome. They hold one session: the browser items reuse the run's cookie and the second account
// signs in once. 34, 41, 43 and 44 skip with a note while LAND_WHEN_CLEARED and AUDIT_LOG are off.
import { adminPages } from './admin-pages-flow.mjs';
import { auditFlow } from './audit-flow.mjs';
import { clonePanel } from './clone-panel-flow.mjs';
import { secondAccount } from './client.mjs';
import { ctcTraffic } from './ctc-flow.mjs';
import { emptyStates } from './empty-state-flow.mjs';
import { flightAgent } from './flight-agent-flow.mjs';
import { flightFailures } from './flight-failures-flow.mjs';
import { flightPath } from './flight-path-flow.mjs';
import { flightTimes } from './flight-times.mjs';
import { goAroundFlow } from './go-around-flow.mjs';
import { landWhenCleared } from './land-cleared-flow.mjs';
import { landingsFlow } from './landings-flow.mjs';
import { orgRace } from './org-race-flow.mjs';
import { searchFlow } from './search-flow.mjs';

/** Runs the items `step` wants, inside the CLI part of the kit: before item 17's cleanup. */
export async function featureItems(step, { cli, kit, account, platformAccount, values, root }) {
  const { origin, headed, prod } = values;
  const web = { chrome: { origin, root, headed, cookie: account.cookie }, account };
  let member;
  const credentials = { second: async () => (member ??= await secondAccount(origin, kit)) };
  const feature = { ...web, credentials };
  await step('33', 'CTC: traffic warnings on start and read, radar by API, MCP and page, separation, path-limited token sees nothing', (m) => ctcTraffic(cli, feature, m));
  await step('34', 'CTC lands: an approval lands it, High Risk holds, separation holds behind a ticket (needs LAND_WHEN_CLEARED)', (m) => landWhenCleared(cli, { web, credentials }, m));
  await step('35', 'Landings: per-push switch, adoption, direct landings, computed states, the rename', (m) => landingsFlow(cli, feature, m));
  await step('36', 'Flight plan and go-around: filed or refused cleanly, findings reach a session, findings_block refuses', (m) => goAroundFlow(cli, web, m));
  await step('37', 'Search across repositories: REST, CLI, MCP, page; private stays private, revoked token refused, beyond the 25 cap', (m) => searchFlow(cli, feature, m));
  await step('38', 'Clone panel: no token line when public, one when private, Copy, phone width', (m) => clonePanel(cli, web, m));
  await step('39', 'Admin: Revenue, revenue-rebuild, Traffic without our own traffic (the dev owner)', (m) => adminPages({ chrome: web.chrome, kitSession: platformAccount, prod }, m));
  await step('40', 'Org delete during create: one of the two wins, nothing stranded; the org pages', (m) => orgRace({ ...feature, platform: platformAccount }, m));
  await step('41', 'Audit: repository events in the org log, filters, chain, exports, page (needs AUDIT_LOG)', (m) =>
    auditFlow({ platform: platformAccount, kitName: account.name, chrome: web.chrome, cookie: account.cookie, origin, credentials }, m),
  );
  await step('42', 'Shared empty state on Sessions, Landings and CTC, wide and at 375 px', (m) => emptyStates(cli, web, m));
  await step('43', 'Flight Path: one Landing from flight plan to black box, landing by itself (needs LAND_WHEN_CLEARED)', (m) => flightPath(cli, { web, credentials }, m));
  await step('44', 'Flight Path failures: stale head, failed check, path limits, fork, races, pause, no rules, rollback (needs LAND_WHEN_CLEARED)', (m) => flightFailures(cli, { web, credentials }, m));
  await step('f1', 'F1, the stale head, repeated with the platform\'s own times (F1_RUNS, default 10): --only 0,12,f1,17', (m) => flightTimes(cli, { credentials }, m));
  const { 'agent-model': model, 'agent-timeout': timeoutS, 'agent-budget': budgetUsd, yes } = values;
  await step('45', `Flight Path with a real agent (${model}) in the sandbox: --only 0,12,45,17 --yes, a model's quota`, (m) =>
    flightAgent(cli, { root, web, credentials, model, timeoutS: Number(timeoutS), budgetUsd: Number(budgetUsd), yes }, m),
  );
}
