// The simulated accounts and repositories, on one of two arms. On `region`, each region's accounts
// sign up and create through that region's serving object, so their authorities and repositories
// start there. On `today`, all of them go through the public path and land near the pinned Worker.
// Both are kept and reused: `.local/platform-live/pool-real-use-<arm>.json` holds names and ids
// only, passwords are derived from the kit's and never stored, and a run's tokens are fresh and
// revoked at its end. Nothing here deletes anything. Addresses are Resend's test inbox.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { poolPath, waves } from '../fanout-bench/repo-pool.mjs';
import { regionAccount } from '../fanout-bench/region-accounts.mjs';
import { seedBlobs, seedFiles } from '../fanout-bench/region-plan.mjs';
import { homeOf } from './plan.mjs';

const AUTHOR = { name: 'Real use', email: 'bench@yonedarepo.invalid' };
/** AUTH_LIMITER is 30 a minute, and one sign-in can take two requests. */
const SIGN_IN_PACE_MS = 4_500;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (text) => Buffer.from(text).toString('base64');

export const PAT_SCOPES = ['repo:read', 'repo:write', 'repo:land', 'repo:review', 'repo:admin'];
export const REPO_SCOPES = ['read', 'write', 'land', 'check'];
export const regionOfAccount = (i, regions) => regions[i % regions.length];
/** The neighbour who reviews account `i`'s work: in its region when there's one, never itself. */
export function reviewerOf(i, accounts, regions) {
  const same = (i + regions.length) % accounts;
  return same === i ? (i + 1) % accounts : same;
}
const username = (arm, i) => `realuse_${arm}_${i}`;
/** The name a hint needs on the `region` arm. */
export const seedName = (arm, i, r) => (arm === 'region' ? `region-hint-sim-${i}-${r}` : `real-use-${i}-${r}`);

async function readSaved(file, target) {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return { target, accounts: [], repos: [] };
  const pool = JSON.parse(text);
  if (pool.target !== target) throw new Error(`${file} belongs to ${pool.target}, not ${target}`);
  return pool;
}
async function save(file, pool) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...pool, saved_at: new Date().toISOString() }, null, 2)}\n`);
}

/** Makes a repository, or finds it where a setup that stopped made it without saving it. */
async function madeOrFound(session, body) {
  try {
    return await session.post('/api/v1/repos', body);
  } catch (e) {
    if (!/NAME_TAKEN/.test(e.message)) throw e;
  }
  const { repos } = await session.get('/api/v1/repos');
  const { id } = repos.find((repo) => repo.name === body.name);
  const { refs } = await session.get(`/api/v1/repos/${id}/refs`);
  return { id, commit: refs['refs/heads/main'] };
}

/** Signs every account in, signing up the missing, then makes the missing repositories. */
export async function preparePool({ arm, target, call, kitPassword, accounts, reposPerAccount, files, regions, log }) {
  const file = poolPath(`real-use-${arm}`);
  const pool = await readSaved(file, target);
  const sessions = [];
  const serveOf = (i) => (arm === 'region' ? homeOf[regionOfAccount(i, regions)] : undefined);
  for (let i = 0; i < accounts; i++) {
    const client = regionOfAccount(i, regions);
    const { session } = await regionAccount({ call, client, serve: serveOf(i), name: username(arm, i), kitPassword });
    sessions.push(session);
    pool.accounts[i] = { username: username(arm, i), name: session.name, client };
    await save(file, pool);
    log(`account ${i + 1} of ${accounts}`);
    if (i + 1 < accounts) await pause(SIGN_IN_PACE_MS);
  }
  const missing = [];
  for (let i = 0; i < accounts; i++) for (let r = 0; r < reposPerAccount; r++) if (!pool.repos.some((p) => p.name === seedName(arm, i, r))) missing.push([i, r]);
  await waves(missing, 4, async ([i, r]) => {
    const name = seedName(arm, i, r);
    const seed = seedFiles(name, files);
    const body = { name, ...(arm === 'region' && { region_hint: serveOf(i) }), policy: { required_checks: [], approvals: 0 }, files: Object.entries(seed).map(([path, text]) => ({ path, content_b64: b64(text) })), message: 'Seed', author: AUTHOR };
    const { id, commit } = await madeOrFound(sessions[i], body);
    pool.repos.push({ id, name, owner: i, seed_commit: commit, files });
    await save(file, pool);
    log(`repository ${pool.repos.length}`);
  });
  // A reviewer who isn't the author: reviews of one's own commits are refused. Adding one twice
  // changes nothing, so a setup that stopped here picks up again.
  await waves(pool.repos.filter((repo) => repo.owner < accounts && !repo.reviewer), 4, async (repo) => {
    const reviewer = pool.accounts[reviewerOf(repo.owner, accounts, regions)].name;
    await sessions[repo.owner].post(`/api/v1/repos/${repo.id}/members`, { account: reviewer, role: 'land' });
    repo.reviewer = reviewer;
    await save(file, pool);
  });
  return { pool, sessions };
}

/** Each account's PAT and each repository's token for this run, with how to revoke them. */
export async function mintCredentials({ sessions, run, repos }) {
  const pats = await Promise.all(sessions.map((s) => s.post('/api/v1/tokens', { name: `real-use-${run}`, scopes: PAT_SCOPES, expires_days: 1 })));
  const label = `real-use-${run}`;
  const tokens = await waves(repos, 8, async (repo) => (await sessions[repo.owner].post(`/api/v1/repos/${repo.id}/tokens`, { name: label, scopes: REPO_SCOPES })).token);
  return {
    pats: pats.map((p) => p.token),
    tokens,
    revoke: async () => {
      const gone = await waves(repos, 8, (repo) => sessions[repo.owner].raw('DELETE', `/api/v1/repos/${repo.id}/tokens/${label}`).catch(() => ({ ok: false })));
      const patsGone = await Promise.all(pats.map((p, i) => sessions[i].raw('DELETE', `/api/v1/tokens/${p.id}`).catch(() => ({ ok: false }))));
      return [...gone, ...patsGone].filter((a) => !a.ok).length;
    },
  };
}

/** `population(kind, region, random, zipf)`: who a new session is. Accounts live in a region, so a
 * person there opens their own repositories, the popular ones most, and a reviewer is a neighbour
 * in the same region. */
export function populationOf({ arm, pool, sessions, credentials, repos, api, front, regions }) {
  const homes = Object.fromEntries(regions.map((region) => [region, pool.accounts.map((_, i) => i).filter((i) => regionOfAccount(i, regions) === region)]));
  const prepared = repos.map((repo, index) => ({ ...repo, index, paths: Object.keys(seedFiles(repo.name, repo.files)), blobs: seedBlobs(repo.name, repo.files) }));
  return (kind, region, random, zipf) => {
    const home = homes[region];
    const i = home[Math.floor(random() * home.length)];
    const own = prepared.filter((r) => r.owner === i);
    const repo = own[zipf(random, own.length)];
    const serve = arm === 'region' ? homeOf[region] : undefined;
    const person = ['browse', 'review', 'search'].includes(kind);
    const reviewer = sessions[reviewerOf(i, sessions.length, regions)].cookie;
    if (person) return { person: i, repo, target: front, serve, cookie: sessions[i].cookie, reviewer };
    return { person: i, repo, target: api, serve, credential: kind === 'mcp' ? credentials.pats[i] : credentials.tokens[repo.index] };
  };
}
