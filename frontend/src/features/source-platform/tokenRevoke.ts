// Revoking a personal token takes the SSH keys it added with it, so the confirmation says how
// many will go and the result says how many went.
import type { Pat } from './PersonalTokens';
import { sourceApi } from './sourceApi';
import type { Loaded } from './useSource';

const sshKeys = (n: number) => `${n} SSH ${n === 1 ? 'key' : 'keys'}`;

/** The confirmation's text: `keys` is how many SSH keys the token added. */
export function revokePrompt(token: Pick<Pat, 'name'>, what: string, keys: number) {
  const also = keys
    ? `This also removes the ${sshKeys(keys)} it added, so Git over SSH with ${
        keys === 1 ? 'that key' : 'those keys'
      } stops too.`
    : 'No SSH keys are removed.';
  return `Revoke ${token.name}? ${what} stop working immediately. ${also}`;
}

/** What a finished revocation did: `removed` is how many SSH keys went with it. */
export const revokedNote = (token: Pick<Pat, 'name'>, removed: number) =>
  removed
    ? `Revoked ${token.name} and removed the ${sshKeys(removed)} it added.`
    : `Revoked ${token.name}. No SSH keys were removed.`;

/** The token's count as of now: the page may predate a `yoneda ssh setup`. A failed read
 * falls back to the listed count, because it must never stop a revocation. */
async function currentKeys(token: Pat) {
  const fresh = await sourceApi<{ tokens: Pat[] }>('/tokens').catch(() => null);
  return fresh?.tokens.find((t) => t.id === token.id)?.ssh_keys ?? token.ssh_keys ?? 0;
}

/** Revokes a personal token after confirming, then re-reads the list. Answers what it did, or
 * null when the person cancelled. */
export async function revokePat(token: Pat, tokens: Loaded<unknown>, what = 'Clients using it') {
  if (!window.confirm(revokePrompt(token, what, await currentKeys(token)))) return null;
  const revoked = await sourceApi<{ removed_ssh_keys?: unknown[] }>(
    `/tokens/${encodeURIComponent(token.id)}`,
    { method: 'DELETE' },
  );
  tokens.reload();
  return revokedNote(token, revoked.removed_ssh_keys?.length ?? 0);
}
