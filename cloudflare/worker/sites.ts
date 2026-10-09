import { jwtVerify, SignJWT } from 'jose';
import { error, response, safeId } from './http';
import { ledger, sha } from './storage';
import type { Env, Json } from './types';

async function signingKey(env: Env) {
  if (!env.VAULT_KEY) throw new Error('Preview signing is not configured');
  return new TextEncoder().encode(await sha(`yoneda:preview:v1:${env.VAULT_KEY}`));
}
export async function previewLink(env: Env, repo: string, evaluation: Json) {
  if (!evaluation.deployment?.digest)
    throw new Error('No independently captured site for this evaluation');
  if (
    !env.SITE_ORIGIN ||
    new URL(env.SITE_ORIGIN).origin === new URL('https://yoneda.invalid').origin
  )
    throw new Error('Isolated site origin is not configured');
  const digest = evaluation.deployment.digest;
  const token = await new SignJWT({ digest, repo })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('yoneda-site-preview')
    .setExpirationTime('1h')
    .sign(await signingKey(env));
  return { url: `${env.SITE_ORIGIN}/v/${digest}/${token}/`, expires_in: 3600 };
}
export async function authorizePreview(env: Env, digest: string, token: string) {
  try {
    const { payload } = await jwtVerify(token, await signingKey(env), {
      algorithms: ['HS256'],
      audience: 'yoneda-site-preview',
    });
    if (payload.digest !== digest || typeof payload.repo !== 'string' || !safeId(payload.repo))
      return false;
    await ledger(env, payload.repo, { op: 'snapshot' });
    return true;
  } catch {
    return false;
  }
}
export async function siteRoute(env: Env, repo: string, req: Request) {
  const snapshot = await ledger(env, repo, { op: 'snapshot' });
  const evaluation = snapshot.evaluations.find(
    (e: Json) => e.id === new URL(req.url).searchParams.get('evaluation'),
  );
  if (!evaluation) return error('NOT_FOUND', 'Evaluation not found', 404);
  return response(await previewLink(env, repo, evaluation));
}
