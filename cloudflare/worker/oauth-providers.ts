// OAuth 2.0 sign-in providers (authorization code flow with PKCE): where each sends the
// browser, how its code is exchanged, and the identity that yields. GitHub asks only for the
// user's profile and emails; Google is OpenID Connect, and its ID token is verified against
// Google's keys (issuer, audience, expiry, nonce). Only a verified email leaves this module.
// Nothing here logs: codes, tokens and emails stay in memory.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './types';

export type ProviderName = 'github' | 'google';
export const PROVIDERS: readonly ProviderName[] = ['github', 'google'];

/** A provider's user, keyed by its stable id; `email` only when the provider verified it. */
export type ProviderIdentity = {
  provider: ProviderName;
  subject: string;
  login: string;
  email: string | null;
};

/** A refusal from (or about) the provider, as the sign-in page names it. */
export class ProviderError extends Error {
  constructor(public reason: 'provider' | 'unverified_email') {
    super(reason);
  }
}

type Client = { id: string; secret: string };

/** The provider's client credentials, or null when either secret is unset (provider off). */
export function client(env: Env, provider: ProviderName): Client | null {
  const [id, secret] =
    provider === 'github'
      ? [env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET]
      : [env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET];
  return id?.trim() && secret?.trim() ? { id: id.trim(), secret: secret.trim() } : null;
}

export const configuredProviders = (env: Env) => PROVIDERS.filter((p) => client(env, p));

/** Where the browser goes to consent. */
export function authorizeUrl(
  provider: ProviderName,
  app: Client,
  redirect: string,
  attempt: { state: string; challenge: string; nonce: string },
) {
  const common = {
    client_id: app.id,
    redirect_uri: redirect,
    state: attempt.state,
    code_challenge: attempt.challenge,
    code_challenge_method: 'S256',
  };
  if (provider === 'github')
    return `https://github.com/login/oauth/authorize?${new URLSearchParams({
      ...common,
      scope: 'read:user user:email',
      allow_signup: 'true',
    })}`;
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    ...common,
    response_type: 'code',
    scope: 'openid email profile',
    nonce: attempt.nonce,
    prompt: 'select_account',
  })}`;
}

/** Exchanges the code (with the attempt's PKCE verifier) for the provider's identity. */
export async function exchange(
  provider: ProviderName,
  app: Client,
  redirect: string,
  code: string,
  attempt: { verifier: string; nonce: string },
): Promise<ProviderIdentity> {
  const form = {
    client_id: app.id,
    client_secret: app.secret,
    code,
    redirect_uri: redirect,
    code_verifier: attempt.verifier,
  };
  if (provider === 'github') {
    // GitHub answers a bad code or verifier with 200 and an `error` field.
    const token = await call('https://github.com/login/oauth/access_token', { body: form });
    if (typeof token.access_token !== 'string') throw new ProviderError('provider');
    const auth = { authorization: `Bearer ${token.access_token}` };
    const [user, emails] = await Promise.all([
      call('https://api.github.com/user', { headers: auth }),
      call('https://api.github.com/user/emails', { headers: auth }),
    ]);
    if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string')
      throw new ProviderError('provider');
    const verified = Array.isArray(emails) ? emails.filter((e) => e?.verified === true) : [];
    const email = (verified.find((e) => e.primary === true) ?? verified[0])?.email;
    return {
      provider,
      subject: String(user.id),
      login: user.login,
      email: typeof email === 'string' ? email.toLowerCase() : null,
    };
  }
  const token = await call('https://oauth2.googleapis.com/token', {
    body: { ...form, grant_type: 'authorization_code' },
  });
  if (typeof token.id_token !== 'string') throw new ProviderError('provider');
  const claims = await jwtVerify(token.id_token, googleKeys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: app.id,
    algorithms: ['RS256'],
  })
    .then((verified) => verified.payload)
    .catch(() => {
      throw new ProviderError('provider');
    });
  if (claims.nonce !== attempt.nonce || typeof claims.sub !== 'string')
    throw new ProviderError('provider');
  if (claims.email_verified !== true || typeof claims.email !== 'string')
    throw new ProviderError('unverified_email');
  const email = claims.email.toLowerCase();
  return { provider, subject: claims.sub, login: email.split('@')[0] ?? '', email };
}

// One key set per isolate: jose caches Google's keys and refetches on an unknown key id.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** A provider request: a form POST when `body` is given, else a GET; JSON back, bounded. */
async function call(
  url: string,
  { body, headers = {} }: { body?: Record<string, string>; headers?: Record<string, string> },
): Promise<any> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'yonedarepo-oauth',
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new ProviderError('provider');
  });
  const text = await response.text();
  if (!response.ok || text.length > 256 * 1024) throw new ProviderError('provider');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('provider');
  }
}
