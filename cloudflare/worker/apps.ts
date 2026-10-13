import { jwtVerify, SignJWT } from 'jose';
import { safeId } from './http';
import { ledger, sha } from './storage';
import type { Env, Json } from './types';

export type TrustedApp = {
  app_id: string;
  revision: string;
  policy_digest: string;
  bundle_digest: string;
  mode: 'preview' | 'published';
  generation: number;
};
async function key(env: Env) {
  if (!env.VAULT_KEY) throw new Error('App preview signing unavailable');
  return new TextEncoder().encode(await sha(`yoneda:app-preview:v1:${env.VAULT_KEY}`));
}
export async function appPreviewLink(env: Env, repo: string, evaluation: Json) {
  if (!env.APP_ORIGIN || !safeId(repo) || !evaluation.app?.bundle_digest)
    throw new Error('Checked app preview unavailable');
  const preview = `${repo}:${evaluation.candidate}`;
  const token = await new SignJWT({
    preview,
    digest: evaluation.app.bundle_digest,
    revision: evaluation.app.revision,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('yoneda-app-preview')
    .setExpirationTime('1h')
    .sign(await key(env));
  return { url: `${env.APP_ORIGIN}/v/${encodeURIComponent(preview)}/${token}/`, expires_in: 3600 };
}
export async function authorizeAppPreview(
  env: Env,
  preview: string,
  token: string,
): Promise<TrustedApp | null> {
  try {
    if (preview.length > 400 || token.length > 4096) return null;
    const separator = preview.indexOf(':');
    const repo = preview.slice(0, separator);
    const candidateId = preview.slice(separator + 1);
    if (separator < 1 || !safeId(repo) || !candidateId) return null;
    const { payload } = await jwtVerify(token, await key(env), {
      algorithms: ['HS256'],
      audience: 'yoneda-app-preview',
    });
    if (payload.preview !== preview) return null;
    const detail = await ledger(env, repo, { op: 'candidate_record', id: candidateId });
    if (
      !['eligible', 'accepted'].includes(detail.status) ||
      detail.revision?.commit !== payload.revision
    )
      return null;
    const evaluation = await ledger(env, repo, { op: 'evaluation_record', id: detail.evaluation });
    if (
      evaluation.candidate !== candidateId ||
      evaluation.app?.bundle_digest !== payload.digest ||
      evaluation.app?.revision !== payload.revision
    )
      return null;
    return {
      app_id: repo,
      revision: evaluation.app.revision,
      policy_digest: evaluation.app.policy_digest,
      bundle_digest: evaluation.app.bundle_digest,
      mode: 'preview',
      generation: 0,
    };
  } catch {
    return null;
  }
}
export async function publishedApp(env: Env, repo: string): Promise<TrustedApp | null> {
  if (!safeId(repo)) return null;
  try {
    const status = await ledger(env, repo, { op: 'repository_status' });
    if (!status.app?.bundle_digest || status.app.revision !== status.published_commit) return null;
    return { app_id: repo, ...status.app, mode: 'published', generation: status.version };
  } catch {
    return null;
  }
}
