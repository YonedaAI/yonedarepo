import { canonicalJson } from './canonical-json';
import { sha } from './storage';
import type { Env, Json } from './types';

function publicRequest(input: Json) {
  const result = structuredClone(input);
  for (const key of ['op', 'now', '_workspace', '_campaign_grant', '_campaign_signing_key'])
    delete result[key];
  return result;
}
const fingerprint = (value: unknown) => sha(`yonedarepo:json:v1\0${canonicalJson(value)}`);
/** Issued only after Workspace authority binds this exact run and frozen budgets. */
export async function campaignGrant(
  env: Env,
  owner: string,
  repo: string,
  approval: Json,
  binding: Json,
) {
  if (!env.VAULT_KEY || !/^[a-f0-9]{64}$/.test(env.VAULT_KEY))
    throw new Error('Campaign signing is not configured');
  if (binding.repo_id !== repo || binding.run_id !== approval.id)
    throw new Error('Campaign grant identity mismatch');
  const claims = {
    workspace: owner,
    repo_id: repo,
    run_id: approval.id,
    campaign: approval.campaign,
    model_budgets: binding.model_budgets,
    request_digest: await fingerprint(publicRequest(approval)),
    expires: Date.now() + 60000,
  };
  const derived = await sha(`yoneda:campaign-grant:v1:${env.VAULT_KEY}`);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(derived),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`yoneda:campaign-grant:v1\0${await fingerprint(claims)}`),
  );
  return {
    claims,
    signature: [...new Uint8Array(bytes)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(''),
  };
}
