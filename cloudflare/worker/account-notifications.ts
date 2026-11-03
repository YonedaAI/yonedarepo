// Only the current cookie session can read or acknowledge its own inbox.
import { error, readJson, response } from './http';
import type { Env, Principal } from './types';
import { workspace } from './workspace';

export async function notificationsRoute(
  req: Request,
  env: Env,
  principal: () => Promise<Principal | null>,
) {
  try {
    return await accountInbox(req, env, principal);
  } catch {
    return error('NOTIFICATIONS_UNAVAILABLE', 'Notifications are unavailable. Try again.', 503);
  }
}

async function accountInbox(req: Request, env: Env, principal: () => Promise<Principal | null>) {
  if (!['GET', 'POST'].includes(req.method))
    return error('NOT_FOUND', 'Unknown account route', 404);
  const who = await principal();
  if (!who) return error('UNAUTHORIZED', 'Sign in to see notifications', 401);
  if (req.method === 'GET')
    return response(await workspace(env, who.workspace, { op: 'notifications_list' }));
  const body = await readJson(req, 1024).catch(() => null);
  const through = body?.through;
  if (!Number.isSafeInteger(through) || through < 0)
    return error('INVALID_INPUT', 'Choose a valid notification time', 400);
  return response(await workspace(env, who.workspace, { op: 'notifications_read', through }));
}
