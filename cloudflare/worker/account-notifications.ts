// Only the current cookie session can read, dismiss or acknowledge its own inbox.
import { error, readJson, response } from './http';
import type { Env } from './types';
import { workspace } from './workspace';

export async function notificationsRoute(
  req: Request,
  env: Env,
  principal: () => Promise<{ workspace: string; sessionHash: string } | null>,
) {
  try {
    return await accountInbox(req, env, principal);
  } catch (failure: any) {
    if (failure?.code === 'UNAUTHORIZED')
      return error('UNAUTHORIZED', 'Sign in to see notifications', 401);
    if (failure?.code === 'INVALID_INPUT')
      return error('INVALID_INPUT', 'Choose a valid notification', 400);
    return error('NOTIFICATIONS_UNAVAILABLE', 'Notifications are unavailable. Try again.', 503);
  }
}

async function accountInbox(
  req: Request,
  env: Env,
  principal: () => Promise<{ workspace: string; sessionHash: string } | null>,
) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method))
    return error('NOT_FOUND', 'Unknown account route', 404);
  const who = await principal();
  if (!who) return error('UNAUTHORIZED', 'Sign in to see notifications', 401);
  const command = (op: string, fields = {}) =>
    workspace(env, who.workspace, { op, session_hash: who.sessionHash, ...fields });
  const suffix = new URL(req.url).pathname.slice('/api/auth/notifications'.length);
  if (req.method === 'DELETE') {
    if (!suffix) return response(await command('notifications_clear'));
    let id: string;
    try {
      id = decodeURIComponent(suffix.slice(1));
    } catch {
      return error('INVALID_INPUT', 'Choose a valid notification', 400);
    }
    if (!/^[a-z][a-z0-9_]{2,31}:[1-9][0-9]{0,18}$/.test(id))
      return error('INVALID_INPUT', 'Choose a valid notification', 400);
    return response(await command('notification_dismiss', { id }));
  }
  if (suffix) return error('NOT_FOUND', 'Unknown account route', 404);
  if (req.method === 'GET') return response(await command('notifications_list'));
  const body = await readJson(req, 1024).catch(() => null);
  const through = body?.through;
  if (!Number.isSafeInteger(through) || through < 0)
    return error('INVALID_INPUT', 'Choose a valid notification time', 400);
  return response(await command('notifications_read', { through }));
}
