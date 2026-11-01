// What each piece costs from this region, one read at a time through a binding: the numbers a
// request through the pinned platform Worker can't give, since from there every piece is the
// Worker's neighbour or an ocean away (docs/global-scale-plan.md). Reads only: the account lookup
// a personal token pays (D1, then the account's authority), an R2 read, and each test
// repository's authority and first shard. Nothing here decides anything for the platform.
import { OWN_TRAFFIC } from '../own-traffic.mjs';

const REPO = /^r[0-9a-f]{20}$/;
const ACCOUNT = /^[a-z0-9._+@-]{1,254}$/;
const MAX_SAMPLES = 20;
const NO_TOKEN = '0'.repeat(64);
const SYSTEM = { _system: 'commits' };
const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';

export const validProbe = (p) =>
  Number.isInteger(p?.samples) &&
  p.samples > 0 &&
  p.samples <= MAX_SAMPLES &&
  ACCOUNT.test(p.account ?? '') &&
  Array.isArray(p.repos) &&
  p.repos.length <= 6 &&
  p.repos.every((r) => REPO.test(r?.id ?? '') && typeof r.data === 'string');

/** `fn`, `samples` times in a row: its first is reported apart, as it may wake something. */
async function timesOf(samples, fn) {
  const ms = [];
  let error;
  for (let i = 0; i < samples; i++) {
    const started = Date.now();
    try {
      await fn();
      ms.push(Date.now() - started);
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 160);
    }
  }
  return { first_ms: ms[0] ?? null, ms: ms.slice(1), failed: samples - ms.length, ...(error ? { error } : {}) };
}

const command = async (stub, url, body) => {
  const answer = await stub.fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const text = await answer.text();
  return { status: answer.status, text };
};

/** The colo a request from here leaves through, and what Cloudflare calls this place. */
export async function here() {
  const trace = await (await fetch(TRACE, { headers: { ...OWN_TRAFFIC } })).text();
  return { colo: /^colo=(.+)$/m.exec(trace)?.[1] ?? null, loc: /^loc=(.+)$/m.exec(trace)?.[1] ?? null };
}

async function authorityRead(env, repo) {
  const stub = env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  const { text } = await command(stub, 'https://source-repository/', { op: 'repo_storage', ...SYSTEM });
  if (!text.includes('db_bytes')) throw new Error(`authority read: ${text.slice(0, 120)}`);
}

async function shardRead(env, repo) {
  const stub = env.COMMIT_SHARDS.get(env.COMMIT_SHARDS.idFromName(`${repo}:0`));
  const { status, text } = await command(stub, 'https://commit-shard/', { op: 'store_status', ...SYSTEM });
  if (status !== 200) throw new Error(`shard read: ${status} ${text.slice(0, 120)}`);
}

export async function probe(env, target, { samples, account, repos }) {
  const pieces = {};
  const measure = async (name, fn) => void (pieces[name] = await timesOf(samples, fn));
  const d1 = {};
  await measure('trace', () => fetch(TRACE, { headers: { ...OWN_TRAFFIC } }).then((r) => r.arrayBuffer()));
  await measure('platform_health', () => fetch(`${target}/health`, { headers: { ...OWN_TRAFFIC } }).then((r) => r.arrayBuffer()));
  await measure('d1', async () => {
    const { meta } = await env.INDEX.prepare('SELECT workspace FROM platform_tokens WHERE token_hash=?').bind(NO_TOKEN).run();
    Object.assign(d1, { served_by_region: meta?.served_by_region ?? null, served_by_primary: meta?.served_by_primary ?? null });
  });
  const authority = env.WORKSPACES.get(env.WORKSPACES.idFromName(`account:${account}`));
  await measure('account_authority', () => command(authority, 'http://workspace/command', { op: 'pat_check', token_hash: NO_TOKEN }));
  await measure('r2_head', () => env.OBJECTS.head('region-probe/none'));
  const listed = (await env.OBJECTS.list({ prefix: 'platform/v1/', limit: 1 })).objects[0];
  if (listed) await measure('r2_get', async () => (await env.OBJECTS.get(listed.key))?.arrayBuffer());
  for (const { id, data } of repos) {
    await measure(`repo_${data}`, () => authorityRead(env, id));
    await measure(`shard_${data}`, () => shardRead(env, id));
  }
  return { pieces, d1, r2_object_bytes: listed?.size ?? null };
}
