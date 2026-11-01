// The simulated accounts and repositories. Both are kept and reused: `.local/platform-live/
// pool-real-use.json` holds names and ids only, each account's password is derived from the kit's
// own and never stored, and a run's tokens are fresh and revoked at its end. Nothing here deletes
// anything. Accounts sign up with the kit's test address (Resend's test inbox, never a person).
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { poolPath, waves } from '../fanout-bench/repo-pool.mjs';
import { seedBlobs, seedFiles } from '../fanout-bench/region-plan.mjs';
import { accountSession, Session } from '../staging/client.mjs';

const AUTHOR = { name: 'Real use', email: 'bench@yonedarepo.invalid' };
const FILE = poolPath('real-use');
/** AUTH_LIMITER is 30 a minute, and one sign-in can take three requests. */
const SIGN_IN_PACE_MS = 6_500;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (text) => Buffer.from(text).toString('base64');

export const passwordOf = (kitPassword, i) => createHmac('sha256', kitPassword).update(`real-use-${i}`).digest('hex');
export const PAT_SCOPES = ['repo:read', 'repo:write', 'repo:land', 'repo:review', 'repo:admin'];
export const REPO_SCOPES = ['read', 'write', 'land', 'check'];
export const seedName = (i, r) => `real-use-${i}-${r}`;

async function readSaved(target) {
  const text = await readFile(FILE, 'utf8').catch(() => null);
  if (!text) return { target, accounts: [], repos: [] };
  const pool = JSON.parse(text);
  if (pool.target !== target) throw new Error(`${FILE} belongs to ${pool.target}, not ${target}`);
  return pool;
}
async function save(pool) {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, `${JSON.stringify({ ...pool, saved_at: new Date().toISOString() }, null, 2)}\n`);
}

/** Signs every account in, signing up the missing, then makes the missing repositories. */
export async function preparePool({ origin, kitPassword, accounts, reposPerAccount, files, log }) {
  const pool = await readSaved(origin);
  const sessions = [];
  for (let i = 0; i < accounts; i++) {
    const username = `realuse${i}`;
    const session = await accountSession(origin, pool.accounts[i]?.identifier ?? username, passwordOf(kitPassword, i)).catch(async () => accountSession(origin, username, passwordOf(kitPassword, i)));
    sessions.push(new Session(`${origin}/api/v1`, { cookie: session.cookie }));
    pool.accounts[i] = { username, name: session.name, identifier: session.identifier };
    await save(pool);
    log(`account ${i + 1} of ${accounts}`);
    if (i + 1 < accounts) await pause(SIGN_IN_PACE_MS);
  }
  const missing = [];
  for (let i = 0; i < accounts; i++) for (let r = 0; r < reposPerAccount; r++) if (!pool.repos.some((p) => p.name === seedName(i, r))) missing.push([i, r]);
  await waves(missing, 4, async ([i, r]) => {
    const name = seedName(i, r);
    const seed = seedFiles(name, files);
    const body = { name, policy: { required_checks: [], approvals: 0 }, files: Object.entries(seed).map(([path, text]) => ({ path, content_b64: b64(text) })), message: 'Seed', author: AUTHOR };
    const { id, commit } = await sessions[i].post('/repos', body);
    // A reviewer who isn't the author: reviews of one's own commits are refused.
    const reviewer = pool.accounts[(i + 1) % accounts].name;
    await sessions[i].post(`/repos/${id}/members`, { account: reviewer, role: 'land' });
    pool.repos.push({ id, name, owner: i, seed_commit: commit, files });
    await save(pool);
    log(`repository ${pool.repos.length}`);
  });
  return { pool, sessions };
}

/** Each account's PAT and each repository's token for this run, with how to revoke them. */
export async function mintCredentials({ pool, sessions, run, repos }) {
  const pats = await Promise.all(sessions.map((s) => s.post('/tokens', { name: `real-use-${run}`, scopes: PAT_SCOPES, expires_days: 1 })));
  const label = `real-use-${run}`;
  const tokens = await waves(repos, 8, async (repo) => (await sessions[repo.owner].post(`/repos/${repo.id}/tokens`, { name: label, scopes: REPO_SCOPES })).token);
  return {
    pats: pats.map((p) => p.token),
    tokens,
    revoke: async () => {
      const gone = await waves(repos, 8, (repo) => sessions[repo.owner].raw('DELETE', `/repos/${repo.id}/tokens/${label}`).catch(() => ({ ok: false })));
      const patsGone = await Promise.all(pats.map((p, i) => sessions[i].raw('DELETE', `/tokens/${p.id}`).catch(() => ({ ok: false }))));
      return [...gone, ...patsGone].filter((a) => !a.ok).length;
    },
  };
}

/** `population(kind, region, random, zipf)`: who a new session is. Accounts live in a region, so a
 * person there opens their own repositories, the popular ones most. */
export function populationOf({ pool, sessions, credentials, repos, api, front, regions }) {
  const homes = Object.fromEntries(regions.map((region) => [region, pool.accounts.map((_, i) => i).filter((i) => regions[i % regions.length] === region)]));
  const prepared = repos.map((repo) => ({ ...repo, paths: Object.keys(seedFiles(repo.name, repo.files)), blobs: seedBlobs(repo.name, repo.files) }));
  return (kind, region, random, zipf) => {
    const home = homes[region];
    const i = home[Math.floor(random() * home.length)];
    const own = prepared.filter((r) => r.owner === i);
    const repo = own[zipf(random, own.length)];
    const person = ['browse', 'review', 'search'].includes(kind);
    const reviewer = sessions[(i + 1) % sessions.length].cookie;
    if (person) return { person: i, repo, target: front, cookie: sessions[i].cookie, reviewer };
    const token = kind === 'mcp' ? credentials.pats[i] : credentials.tokens[repos.indexOf(repos.find((r) => r.id === repo.id))];
    return { person: i, repo, target: api, credential: token };
  };
}
