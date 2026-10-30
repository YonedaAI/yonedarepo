// Where an account's picture is served, for the browser: the signed-in person's own at
// `/api/v1/account/avatar`, anyone's at `/api/v1/avatars/<handle>`, each with a version that
// changes with the picture. The account's WorkspaceAuthority decides which picture it is
// (platform-avatars.ts serves it). Public URLs name the handle, never the account
// identifier: an email-named account's picture is reached by the handle it picked.
import { normalizeHandle } from '../../shared/account';
import type { Env } from './types';
import { workspace } from './workspace';

export type AvatarInfo = { source: 'upload' | 'provider' | null; version: string | null };

export const avatarInfo = (env: Env, account: string) =>
  workspace(env, account, { op: 'avatar_get' }) as Promise<AvatarInfo>;

/** The signed-in person's own picture URL, or null for none. */
export const ownAvatarUrl = (info: AvatarInfo | null) =>
  info?.version ? `/api/v1/account/avatar?v=${info.version}` : null;

/** Anyone's picture URL by their handle, or null for none (or no valid handle). */
export function publicAvatarUrl(handle: string, info: AvatarInfo | null) {
  if (!info?.version || normalizeHandle(handle) !== handle) return null;
  return `/api/v1/avatars/${handle}?v=${info.version}`;
}

/** A profile's picture URL: a person's by handle; an organization has none. The owner is
 * repo-paths' HandleOwner, typed here by shape so the front Worker never imports repo-paths. */
export async function profileAvatarUrl(
  env: Env,
  owner: { kind: 'user' | 'org' | 'alias'; account: string; handle: string },
) {
  if (owner.kind === 'org') return null;
  const info = await avatarInfo(env, owner.account).catch(() => null);
  return publicAvatarUrl(owner.handle, info);
}
