// An organization connects like an account: for anyone GitHub counts on one of the repositories
// the App was given. An `installation_id` is anyone's to write, so GitHub is asked about the
// GitHub user this account linked, and the App needs no extra permission to ask.
import { appInstallations, type Installation, personOnInstallation } from './platform-github-app';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** Organizations looked at for one person. */
const MOST_ORGS = 20;

export const onOrganization = (seen: Installation) =>
  seen.target_type === 'Organization' && seen.account?.type === 'Organization';

/** Connects `seen` for `account`, whose linked GitHub user is `person`, if GitHub agrees. */
export async function joinOrganization(
  env: Env,
  account: string,
  person: string,
  seen: Installation,
) {
  const subject = await personOnInstallation(env, seen.id, person);
  if (!subject) return 'not_member' as const;
  const { linked } = await workspace(env, account, {
    op: 'identity_check',
    provider: 'github',
    subject,
  });
  if (linked !== true) return 'other_account' as const;
  await workspace(env, account, {
    op: 'github_installation_put',
    installation: seen.id,
    login: seen.account?.login,
    target_type: 'Organization',
    target_id: seen.account?.id,
    connected_by: subject,
  });
  return 'connected' as const;
}

/** Connects each organization already holding the App that `person` can reach: GitHub only asks
 * someone who isn't an owner to wait, and sends nothing back when the owner agrees. */
export async function joinReachable(env: Env, account: string, person: string) {
  const { installations } = await workspace(env, account, { op: 'github_installation_list' });
  const held = new Set((installations as Json[]).map((row) => row.installation));
  const open = (await appInstallations(env))
    .filter((seen) => onOrganization(seen) && !seen.suspended_at && !held.has(seen.id))
    .slice(0, MOST_ORGS);
  const results = await Promise.all(
    open.map((seen) => joinOrganization(env, account, person, seen)),
  );
  return results.includes('connected');
}
