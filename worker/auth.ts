import { createRemoteJWKSet, jwtVerify } from 'jose';
import { sessionValid } from './session';
import { sha } from './storage';
import type { Env } from './types';
export async function authorized(req: Request, env: Env) {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return false;
  if (await sessionValid(req, env)) return true;
  const authorization = req.headers.get('authorization');
  if (env.OWNER_TOKEN && authorization?.startsWith('Bearer ')) {
    const supplied = await sha(authorization.slice(7));
    const expected = await sha(env.OWNER_TOKEN);
    if (supplied === expected) return true;
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const assertion = req.headers.get('cf-access-jwt-assertion');
  if (!assertion) return false;
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    await jwtVerify(assertion, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), {
      issuer,
      audience: env.ACCESS_AUD,
    });
    return true;
  } catch {
    return false;
  }
}
