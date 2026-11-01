// The driver's side of the regional clients (region-worker.js): where they are, and a call to one
// that reports a failure rather than throwing it. Each is a Worker of its own because targeted
// placement holds a whole Worker near one cloud region. Dev only, like every bench.
import { REGION_VERSION } from './region-steps.js';
import { devSpec, requireDev } from './guard.mjs';

/** Client regions, with what the plan calls the data region next to each. */
export const CLIENTS = {
  na: { role: 'region-na', near: 'enam', label: 'North America', placed: 'aws:us-east-1' },
  eu: { role: 'region-eu', near: 'weur', label: 'Europe', placed: 'aws:eu-central-1' },
  ap: { role: 'region-ap', near: 'apac', label: 'Asia', placed: 'aws:ap-southeast-1' },
};
export const DATA_REGIONS = ['enam', 'weur', 'apac'];

/** A regional client's URL, from dev's spec. */
export const clientUrl = (name, spec = devSpec()) => `https://${spec.prefix}-${CLIENTS[name].role}.${spec.subdomain}.workers.dev`;

/** `call(client, body)` against the named regional clients; `urls` replaces them in a test. */
export function regionalClients({ key, target, urls, local = false }) {
  const urlOf = (name) => urls?.[name] ?? clientUrl(name);
  requireDev([target, ...Object.keys(urls ?? CLIENTS).map(urlOf)], { local });
  const call = async (name, body) => {
    const started = Date.now();
    let response;
    try {
      response = await fetch(urlOf(name), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bench-key': key },
        body: JSON.stringify({ target, ...body }),
      });
    } catch (e) {
      return { failed: `client ${name} fetch failed after ${Date.now() - started} ms: ${String(e?.cause?.code ?? e?.message ?? e)}`.slice(0, 300) };
    }
    if (response.status !== 200) {
      const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      return { failed: `client ${name} answered ${response.status}: ${text}` };
    }
    return { ...(await response.json()), placement: response.headers.get('cf-placement') };
  };
  return { call };
}

/** Where each client really runs; throws unless all answer, on this version, in distinct colos:
 * clients that share one mean placement did not apply, and the matrix would measure nothing. */
export async function placedClients({ call }, names) {
  const seen = {};
  for (const name of names) {
    const answer = await call(name, { ping: true });
    if (answer.failed) throw new Error(`${answer.failed}: deploy the regional clients first`);
    if (answer.bench !== REGION_VERSION) throw new Error(`Client ${name} is version ${answer.bench}, not ${REGION_VERSION}: deploy it`);
    seen[name] = { colo: answer.colo, loc: answer.loc, request_colo: answer.request_colo, placement: answer.placement };
  }
  const colos = Object.values(seen).map((s) => s.colo);
  if (colos.includes(null) || new Set(colos).size < names.length) throw new Error(`Clients are not apart: ${JSON.stringify(seen)}`);
  return seen;
}
