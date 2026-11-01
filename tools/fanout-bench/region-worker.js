// A client placed in one region (North America, Europe or Asia), for the latency matrix
// (tools/platform-region-matrix.mjs) and the real-use simulation (tools/platform-real-use.mjs).
// Workers can't run Git, so what it sends are the request forms: requests from a client here
// enter Cloudflare here, as a person's or an agent's would, less their own last mile. `ping`
// says where this Worker really runs, `steps` sends requests, `probe` times each piece.
import { here, probe, validProbe } from './region-probe.js';
import { REGION_VERSION, runSteps, validSteps } from './region-steps.js';
import { TARGET } from './requests.js';

const json = (value, status = 200) => Response.json(value, { status });

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || request.headers.get('x-bench-key') !== env.BENCH_KEY) return json({ error: 'forbidden' }, 403);
    const { target, ping, steps, parallel, probe: asked } = await request.json();
    if (ping) return json({ bench: REGION_VERSION, ...(await here()), request_colo: request.cf?.colo ?? null, placement: request.headers.get('cf-placement') });
    if (!TARGET.test(target ?? '')) return json({ error: 'bad request' }, 400);
    if (steps !== undefined) return validSteps(steps) ? json({ results: await runSteps(target, steps, parallel === true) }) : json({ error: 'bad request' }, 400);
    return validProbe(asked) ? json(await probe(env, target, asked)) : json({ error: 'bad request' }, 400);
  },
};
