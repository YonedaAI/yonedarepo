import { createRemoteJWKSet, jwtVerify } from 'jose';
import { accountPrincipal } from './accounts';
import { grantPrincipal } from './grants';
import { sessionValid } from './session';
import { sha } from './storage';
import type { Env, Principal } from './types';
export async function authorized(req: Request, env: Env) {
  return Boolean(await authenticate(req, env));
}
export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return null;
  if (req.headers.get('authorization')?.startsWith('Bearer yoneda.'))
    return grantPrincipal(req, env);
  const account = await accountPrincipal(req, env);
  if (account) return account;
  const admin: Principal = { workspace: '_admin', role: 'admin' };
  if (await sessionValid(req, env)) return admin;
  const authorization = req.headers.get('authorization');
  if (env.OWNER_TOKEN && authorization?.startsWith('Bearer ')) {
    const supplied = await sha(authorization.slice(7));
    const expected = await sha(env.OWNER_TOKEN);
    if (supplied === expected) return admin;
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const assertion = req.headers.get('cf-access-jwt-assertion');
  if (!assertion) return null;
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    await jwtVerify(assertion, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), {
      issuer,
      audience: env.ACCESS_AUD,
    });
    return admin;
  } catch {
    return null;
  }
}
