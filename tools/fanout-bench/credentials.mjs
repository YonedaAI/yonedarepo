// Fresh credentials for one run, revoked when it ends. `tokens` (`yrp_`) are repository tokens,
// which skip D1 and the account authorities; `pat` (`ypat_`) are personal access tokens, checked
// with D1 and the account's WorkspaceAuthority on every request, so they are the arm that says
// anything about those. An account holds at most 50 live PATs, so writers share `pats` of them
// and every PAT belongs to one account: this measures one account's authority, not many.
export const PAT_SCOPES = ['repo:read', 'repo:write', 'repo:land'];
export const TOKEN_SCOPES = ['read', 'write', 'land'];
const MAX_PATS = 40;

/** A run id: short, lowercase and unique enough for token names and paths. */
export const runId = (now = Date.now()) => `x${now.toString(36)}`;

/** `{tokenFor(repoIndex, slot), revoke()}`: `slots` credentials per repository. */
export async function writerCredentials(session, repos, { principals, slots, run, pats = 10 }) {
  if (principals === 'pat') {
    const count = Math.min(pats, MAX_PATS);
    const made = await Promise.all(Array.from({ length: count }, async (_, i) => session.post('/tokens', { name: `bench-${run}-${i}`, scopes: PAT_SCOPES, expires_days: 1 })));
    return {
      tokenFor: (r, slot) => made[(r * slots + slot) % count].token,
      revoke: async () => {
        const answers = await Promise.all(made.map((t) => session.call('DELETE', `/tokens/${t.id}`).catch(() => ({ status: 0 }))));
        return answers.filter((a) => a.status !== 200).length;
      },
    };
  }
  const label = `b${run}w`;
  const minted = [];
  for (let i = 0; i < repos.length; i += 10)
    minted.push(...(await Promise.all(repos.slice(i, i + 10).map((repo) => session.mintTokens(repo, slots, label)))));
  return {
    tokenFor: (r, slot) => minted[r][slot],
    revoke: async () => {
      let left = 0;
      for (let i = 0; i < repos.length; i += 10)
        left += (await Promise.all(repos.slice(i, i + 10).map((repo) => session.revokeTokens(repo, slots, label)))).reduce((n, v) => n + v, 0);
      return left;
    },
  };
}
