// Where an account's picture is served, for the browser: the signed-in person's own at
// `/api/v1/account/avatar`, anyone's at `/api/v1/avatars/<name>`, each with a version
// that changes with the picture. The account's WorkspaceAuthority decides which picture
// it is (platform-avatars.ts serves it). An email-named account has no public picture URL:
// the address would be in it.
import { normalizeAccountIdentifier } from '../../shared/account';
import type { Env } from './types';
import { workspace } from './workspace';

export type AvatarInfo = { source: 'upload' | 'provider' | null; version: string | null };

export const avatarInfo = (env: Env, account: string) =>
  workspace(env, account, { op: 'avatar_get' }) as Promise<AvatarInfo>;

/** The signed-in person's own picture URL, or null for none. */
export const ownAvatarUrl = (info: AvatarInfo | null) =>
  info?.version ? `/api/v1/account/avatar?v=${info.version}` : null;

/** Anyone's picture URL for public pages (profiles), or null: none, or an email-named account. */
export function publicAvatarUrl(handle: string, info: AvatarInfo | null) {
  if (!info?.version || !isPublicHandle(handle)) return null;
  return `/api/v1/avatars/${handle}?v=${info.version}`;
}

/** The picture URL of a profile's handle (unknown accounts have none). */
export async function profileAvatarUrl(env: Env, handle: string) {
  if (!isPublicHandle(handle)) return null;
  const info = await avatarInfo(env, handle).catch(() => null);
  return publicAvatarUrl(handle, info);
}

/** A canonical account name that is not an email address. */
export const isPublicHandle = (name: string) =>
  normalizeAccountIdentifier(name) === name && !name.includes('@');
