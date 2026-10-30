// OAuth sign-in (GitHub, Google) against mocked provider endpoints: the authorization code
// flow with PKCE, state and nonce, identity-keyed accounts, refused silent merges, linking and
// unlinking, and providers hidden when their secrets are missing. Simulated providers only.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
/** Welcome emails the account-created hook asked the platform for (its entrypoint method is
 * faked here), with the contact email the platform's job would send to. */
const welcomed: { workspace?: string; to?: string }[] = [];
const configured: Env = {
  ...bindings,
  PLATFORM: {
    accountCreated: async (account: string) => {
      const state = await workspace(bindings, account, { op: 'welcome_state' });
      welcomed.push({ workspace: account, to: state.email });
    },
  } as unknown as Env['PLATFORM'],
  GITHUB_OAUTH_CLIENT_ID: 'gh-client',
  GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'google-client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
};
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

type Profile = { id: string; login: string; email: string; verified?: boolean };
/** Codes the fake provider issued: each bound to the PKCE challenge of the attempt it came from. */
const issued = new Map<string, { challenge: string; nonce: string; profile: Profile }>();
const exchanges: string[] = [];

async function s256(verifier: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

beforeEach(() => {
  issued.clear();
  welcomed.length = 0;
  exchanges.length = 0;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const form = () => new URLSearchParams(String(init?.body ?? ''));
    const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    if (url.href === 'https://github.com/login/oauth/access_token') {
      const body = form();
      exchanges.push(`github:${body.get('client_id')}`);
      const grant = issued.get(body.get('code') ?? '');
      if (
        !grant ||
        body.get('client_secret') !== 'gh-secret' ||
        grant.challenge !== (await s256(body.get('code_verifier') ?? ''))
      )
        return Response.json({ error: 'bad_verification_code' }); // GitHub answers 200
      return Response.json({ access_token: `gho_${body.get('code')}`, token_type: 'bearer' });
    }
    if (url.href === 'https://api.github.com/user') {
      const grant = issued.get(bearer.replace('gho_', ''));
      if (!grant) return new Response('unauthorized', { status: 401 });
      return Response.json({ id: Number(grant.profile.id), login: grant.profile.login });
    }
    if (url.href === 'https://api.github.com/user/emails') {
      const grant = issued.get(bearer.replace('gho_', ''));
      if (!grant) return new Response('unauthorized', { status: 401 });
      return Response.json([
        { email: 'noreply@users.github.test', primary: false, verified: true },
        { email: grant.profile.email, primary: true, verified: grant.profile.verified ?? true },
      ]);
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const body = form();
      exchanges.push(`google:${body.get('client_id')}`);
      const grant = issued.get(body.get('code') ?? '');
      if (
        !grant ||
        body.get('grant_type') !== 'authorization_code' ||
        grant.challenge !== (await s256(body.get('code_verifier') ?? ''))
      )
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const idToken = await new SignJWT({
        email: grant.profile.email,
        email_verified: grant.profile.verified ?? true,
        nonce: grant.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer('https://accounts.google.com')
        .setAudience(configured.GOOGLE_OAUTH_CLIENT_ID as string)
        .setSubject(grant.profile.id)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return Response.json({ access_token: 'ya29', id_token: idToken, token_type: 'Bearer' });
    }
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs')
      return Response.json({ keys: [jwk] });
    return original(input, init);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const call = (path: string, init: RequestInit = {}, using: Env = configured) =>
  frontFetch(new Request(`https://yoneda.test${path}`, { redirect: 'manual', ...init }), using);
const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];

type Attempt = { state: string; nonce: string; challenge: string; binding: string; url: URL };

async function start(
  provider: 'github' | 'google',
  options: { session?: string; intent?: 'link'; returnTo?: string } = {},
): Promise<Attempt> {
  const query = new URLSearchParams();
  if (options.intent) query.set('intent', options.intent);
  if (options.returnTo) query.set('return_to', options.returnTo);
  const response = await call(`/auth/${provider}/start?${query}`, {
    headers: options.session ? { cookie: options.session } : {},
  });
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get('location') ?? '');
  const binding = cookieOf(response, 'yoneda_oauth') ?? '';
  expect(response.headers.getSetCookie().join()).toMatch(/yoneda_oauth=.*HttpOnly.*SameSite=Lax/);
  return {
    url,
    binding,
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
  };
}

/** The provider's consent: a code bound to the attempt's challenge and nonce. */
function consent(attempt: Attempt, profile: Profile) {
  const code = `code-${crypto.randomUUID()}`;
  issued.set(code, { challenge: attempt.challenge, nonce: attempt.nonce, profile });
  return code;
}

async function callback(
  provider: 'github' | 'google',
  attempt: Attempt,
  query: Record<string, string>,
  binding = attempt.binding,
) {
  const params = new URLSearchParams({ state: attempt.state, ...query });
  return call(`/auth/${provider}/callback?${params}`, { headers: { cookie: binding } });
}

async function signIn(provider: 'github' | 'google', profile: Profile) {
  const attempt = await start(provider);
  const response = await callback(provider, attempt, { code: consent(attempt, profile) });
  return { response, attempt, session: cookieOf(response, 'yoneda_account') };
}

async function whoami(session?: string) {
  const response = await call('/api/auth/session', { headers: session ? { cookie: session } : {} });
  return (await response.json<{ authenticated: boolean; username?: string }>()).username ?? null;
}
const exists = async (name: string) =>
  (
    await bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${name}`))
      .fetch('http://workspace/command', {
        method: 'POST',
        body: JSON.stringify({ op: 'account_exists' }),
      })
      .then((r) => r.json<{ exists: boolean }>())
  ).exists;
const errorOf = (response: Response) =>
  new URL(response.headers.get('location') ?? '', 'https://yoneda.test').searchParams.get(
    'auth_error',
  );

const octo: Profile = { id: '583231', login: 'Octo-Cat', email: 'octo@example.com' };
const jane: Profile = { id: '1098765432', login: '', email: 'jane.doe@example.org' };

it('GitHub: PKCE and state go out, a session cookie comes back, the account is named after the login', async () => {
  const attempt = await start('github');
  expect(attempt.url.origin + attempt.url.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(Object.fromEntries(attempt.url.searchParams)).toMatchObject({
    client_id: 'gh-client',
    redirect_uri: 'https://yoneda.test/auth/github/callback',
    scope: 'read:user user:email',
    code_challenge_method: 'S256',
  });
  expect(attempt.state).toMatch(/^[a-f0-9]{64}$/);
  expect(attempt.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const response = await callback('github', attempt, { code: consent(attempt, octo) });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('https://yoneda.test/');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const cookies = response.headers.getSetCookie().join('\n');
  expect(cookies).toMatch(/yoneda_account=octo_cat\.[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict/);
  expect(cookies).toMatch(/yoneda_oauth=; .*Max-Age=0/);
  expect(await whoami(cookieOf(response, 'yoneda_account'))).toBe('octo_cat');
  expect(exchanges).toEqual(['github:gh-client']);
});

it('Google: the ID token is verified (issuer, audience, nonce) and the account is named after the email', async () => {
  const attempt = await start('google', { returnTo: '/device?code=BCDF-GHJK' });
  expect(attempt.url.origin + attempt.url.pathname).toBe(
    'https://accounts.google.com/o/oauth2/v2/auth',
  );
  expect(Object.fromEntries(attempt.url.searchParams)).toMatchObject({
    client_id: configured.GOOGLE_OAUTH_CLIENT_ID,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge_method: 'S256',
  });
  expect(attempt.nonce).toMatch(/^[a-f0-9]{32}$/);
  const response = await callback('google', attempt, { code: consent(attempt, jane) });
  // Back where the sign-in started (the device approval page here).
  expect(response.headers.get('location')).toBe('https://yoneda.test/device?code=BCDF-GHJK');
  expect(await whoami(cookieOf(response, 'yoneda_account'))).toBe('jane_doe');
});

it('refuses a replayed state, and a state from another browser', async () => {
  const { attempt, session } = await signIn('github', octo);
  expect(session).toBeTruthy();
  const replay = await callback('github', attempt, { code: consent(attempt, octo) });
  expect(errorOf(replay)).toBe('state');
  expect(cookieOf(replay, 'yoneda_account')).toBeUndefined();
  // A state started in the attacker's browser cannot be completed in the victim's.
  const attackers = await start('github');
  const victim = await start('github');
  const crossed = await callback(
    'github',
    attackers,
    { code: consent(attackers, octo) },
    victim.binding,
  );
  expect(errorOf(crossed)).toBe('state');
  expect(cookieOf(crossed, 'yoneda_account')).toBeUndefined();
  // ... and the mismatch spent it: the right browser cannot use it afterwards either.
  const after = await callback('github', attackers, { code: consent(attackers, octo) });
  expect(errorOf(after)).toBe('state');
});

it('refuses a code issued for another attempt (PKCE mismatch)', async () => {
  const attackers = await start('github');
  const code = consent(attackers, octo); // bound to the attacker's challenge
  const victim = await start('github');
  const injected = await callback('github', victim, { code });
  expect(errorOf(injected)).toBe('provider');
  expect(cookieOf(injected, 'yoneda_account')).toBeUndefined();
  expect(await exists('octo_cat')).toBe(false);
  const google = await start('google');
  const googleCode = consent(attackers, jane);
  expect(errorOf(await callback('google', google, { code: googleCode }))).toBe('provider');
});

it('refuses a Google account whose email is not verified, creating nothing', async () => {
  const { response } = await signIn('google', { ...jane, verified: false });
  expect(errorOf(response)).toBe('unverified_email');
  expect(cookieOf(response, 'yoneda_account')).toBeUndefined();
  expect(await exists('jane_doe')).toBe(false);
});

it('denied consent and provider errors come back as errors, spending the attempt', async () => {
  const attempt = await start('github', { returnTo: '/device' });
  const denied = await callback('github', attempt, { error: 'access_denied' });
  expect(denied.headers.get('location')).toBe('https://yoneda.test/device?auth_error=denied&auth_provider=github');
  expect(errorOf(await callback('github', attempt, { code: consent(attempt, octo) }))).toBe('state');
  const other = await start('google');
  expect(errorOf(await callback('google', other, { error: 'server_error' }))).toBe('provider');
});

it('creates the account once; a second sign-in reuses the identity, and a taken name gets a suffix', async () => {
  const signup = await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email: 'octo_cat@example.net', password: 'a long test password' }),
  });
  expect(signup.status).toBe(200);
  welcomed.length = 0; // the password sign-up's own welcome
  const first = await signIn('github', octo);
  expect(await whoami(first.session)).toBe('octo_cat2');
  const second = await signIn('github', { ...octo, login: 'renamed' });
  expect(await whoami(second.session)).toBe('octo_cat2');
  // One welcome, to the provider-verified address, for the new account only.
  expect(welcomed).toEqual([{ workspace: 'octo_cat2', to: octo.email }]);
  expect(await exists('octo_cat3')).toBe(false);
  expect(await exists('renamed')).toBe(false);
  // The provider account still cannot sign in with a password.
  const password = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'octo_cat2', password: 'a long test password' }),
  });
  expect(password.status).toBe(401);
});

it('never merges on a matching email: the owner signs in and links instead', async () => {
  const github = await signIn('github', octo);
  const sameEmail = { id: 'google-sub-1', login: '', email: octo.email };
  const refused = await signIn('google', sameEmail);
  expect(errorOf(refused.response)).toBe('email_in_use');
  expect(cookieOf(refused.response, 'yoneda_account')).toBeUndefined();
  expect(await exists('octo')).toBe(false);
  // An address a password account signed up with is protected the same way.
  await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email: 'pat@example.net', password: 'a long test password' }),
  });
  const named = await signIn('google', { id: 'google-sub-2', login: '', email: 'pat@example.net' });
  expect(errorOf(named.response)).toBe('email_in_use');
  // Signed in as the owner, linking Google is allowed; then Google signs in to that account.
  const link = await start('google', { session: github.session, intent: 'link' });
  const linked = await callback('google', link, { code: consent(link, sameEmail) });
  expect(linked.headers.get('location')).toBe('https://yoneda.test/settings?linked=google');
  const listed = await call('/api/auth/identities', { headers: { cookie: github.session ?? '' } });
  expect(
    (await listed.json<{ identities: { provider: string }[] }>()).identities.map((i) => i.provider),
  ).toEqual(['github', 'google']);
  const viaGoogle = await signIn('google', sameEmail);
  expect(await whoami(viaGoogle.session)).toBe('octo_cat');
  // Another account cannot link an identity someone else holds.
  const other = await signIn('github', { id: '777', login: 'other', email: 'other@example.com' });
  const steal = await start('google', { session: other.session, intent: 'link' });
  const stolen = await callback('google', steal, { code: consent(steal, sameEmail) });
  expect(errorOf(stolen)).toBe('identity_taken');
  expect(new URL(stolen.headers.get('location') ?? '').pathname).toBe('/settings');
  // Refusals, links and repeat sign-ins never welcome; each new account once.
  expect(welcomed.map((w) => w.workspace)).toEqual(['octo_cat', 'pat', 'other']);
});

it('starts on the public origin, so the callback finds its cookies on the same host', async () => {
  const apex: Env = { ...configured, PUBLIC_APP_ORIGIN: 'https://yoneda.test' };
  const www = await frontFetch(
    new Request('https://www.yoneda.test/auth/github/start?return_to=%2Fsettings', {
      redirect: 'manual',
    }),
    apex,
  );
  expect(www.headers.get('location')).toBe(
    'https://yoneda.test/auth/github/start?return_to=%2Fsettings',
  );
  expect(cookieOf(www, 'yoneda_oauth')).toBeUndefined();
});

it('linking needs a signed-in session', async () => {
  const response = await call('/auth/google/start?intent=link');
  expect(response.status).toBe(302);
  expect(errorOf(response)).toBe('session');
});

it('refuses to unlink the last way to sign in', async () => {
  const { session } = await signIn('github', octo);
  const unlink = (provider: string) =>
    call('/api/auth/unlink', {
      method: 'POST',
      headers: { cookie: session ?? '' },
      body: JSON.stringify({ provider }),
    });
  const refused = await unlink('github');
  expect(refused.status).toBe(400);
  expect((await refused.json<{ error: { code: string } }>()).error.code).toBe('LAST_SIGNIN_METHOD');
  const link = await start('google', { session, intent: 'link' });
  await callback('google', link, { code: consent(link, { ...jane, id: 'g-9' }) });
  expect((await unlink('github')).status).toBe(200);
  expect((await unlink('google')).status).toBe(400);
  // The unlinked identity (and its email) no longer reach the account: it starts a new one.
  const again = await signIn('github', octo);
  expect(await whoami(again.session)).toBe('octo_cat2');
});

it('hides a provider whose secrets are missing, and its routes answer 404', async () => {
  const githubOnly: Env = {
    ...configured,
    GOOGLE_OAUTH_CLIENT_ID: undefined,
    GOOGLE_OAUTH_CLIENT_SECRET: '',
  };
  const listed = await call('/api/auth/providers', {}, githubOnly);
  expect(await listed.json()).toEqual({ providers: ['github'] });
  expect((await call('/auth/google/start', {}, githubOnly)).status).toBe(404);
  expect((await call('/auth/google/callback?state=x&code=y', {}, githubOnly)).status).toBe(404);
  expect(await (await call('/api/auth/providers', {}, bindings)).json()).toEqual({ providers: [] });
  expect((await call('/auth/github/start', {}, bindings)).status).toBe(404);
  expect((await call('/auth/gitlab/start')).status).not.toBe(302);
});

it('rate-limits the sign-in routes per client', async () => {
  const limited: Env = { ...configured, AUTH_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await call('/auth/github/callback?state=x&code=y', {}, limited);
  expect(errorOf(response)).toBe('rate_limited');
  expect((await call('/auth/github/start', {}, limited)).status).toBe(302);
  expect(errorOf(await call('/auth/github/start', {}, limited))).toBe('rate_limited');
});

it('an OAuth-signed-in browser approves a yoneda login device code', async () => {
  const { session } = await signIn('github', octo);
  const code = await bindings.SELF.fetch('https://yoneda/api/v1/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'yoneda-cli test' }),
  });
  expect(code.status).toBe(200);
  const { user_code } = await code.json<{ user_code: string }>();
  const approve = await bindings.SELF.fetch('https://yoneda/api/v1/device/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session ?? '' },
    body: JSON.stringify({ user_code, scopes: ['repo:read'], expires_days: 1 }),
  });
  expect(approve.status).toBe(200);
});
