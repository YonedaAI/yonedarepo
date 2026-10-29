// Sign-in with GitHub and Google (`/auth/<provider>/start`, `/auth/<provider>/callback`) on
// the front Worker. Start records the attempt server-side (`oauth:<state digest>`: PKCE
// verifier, nonce, intent, return path and a digest of a browser-binding cookie) and sends
// the browser to the provider; the callback consumes that record once, checks the binding,
// exchanges the code and signs in, links or creates the account. A provider whose secrets
// are unset is off: its routes answer 404 and the sign-in page hides it. Failures return to
// the page with `auth_error=<code>`; logs carry only the provider and that code.
import { encodeAccountIdentifier } from '../../shared/account';
import { randomToken, sessionCookie, signedInSession } from './accounts';
import { error } from './http';
import { linkTo, type Outcome, signInWith } from './oauth-identity';
import {
  authorizeUrl,
  client,
  exchange,
  PROVIDERS,
  ProviderError,
  type ProviderName,
} from './oauth-providers';
import { sha } from './storage';
import type { Env, Json } from './types';
import { publicOrigin } from './website-metadata';

const ROUTE = /^\/auth\/([a-z]+)\/(start|callback)$/;
const BINDING = 'yoneda_oauth';

export async function oauthRoute(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const provider = match[1] as ProviderName;
  const app = PROVIDERS.includes(provider) ? client(env, provider) : null;
  if (!app) return error('NOT_FOUND', 'Unknown sign-in provider', 404);
  if (req.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'Use GET', 405);
  const origin = publicOrigin(req, env.PUBLIC_APP_ORIGIN);
  if (!origin) return error('MISCONFIGURED', 'Invalid public application origin', 500);
  const redirect = `${origin}/auth/${provider}/callback`;
  // Without an attempt to name a return path, a failure goes to the sign-in page.
  const fail = (code: string, to = '/signin') => {
    console.warn(JSON.stringify({ event: 'oauth.failed', provider, step: match[2], code }));
    return back(origin, to, { auth_error: code, auth_provider: provider });
  };
  if (
    env.AUTH_LIMITER &&
    !(
      await env.AUTH_LIMITER.limit({
        key: `oauth:${req.headers.get('cf-connecting-ip') ?? 'local'}`,
      })
    ).success
  )
    return clearBinding(req, fail('rate_limited'));

  if (match[2] === 'start') {
    // Start on the host the callback returns to (www -> apex), or its binding cookie and the
    // session cookie would land on another host. Only www moves, so no config loops.
    if (url.hostname === `www.${new URL(origin).hostname}`)
      return redirectTo(`${origin}${url.pathname}${url.search}`);
    const intent = url.searchParams.get('intent') === 'link' ? 'link' : 'signin';
    const returnTo = intent === 'link' ? '/settings' : safePath(url.searchParams.get('return_to'));
    const session = intent === 'link' ? await signedInSession(req, env) : null;
    if (intent === 'link' && !session) return fail('session', '/settings');
    const state = randomToken();
    const binding = randomToken();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = randomToken(16);
    await attempt(env, state, {
      op: 'oauth_flow_put',
      provider,
      binding_hash: await sha(binding),
      verifier,
      nonce,
      intent,
      account: session?.account,
      session_hash: session?.sessionHash,
      return_to: returnTo,
    });
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    const response = redirectTo(authorizeUrl(provider, app, redirect, { state, challenge, nonce }));
    response.headers.append('set-cookie', bindingCookie(req, binding));
    return response;
  }

  const state = url.searchParams.get('state') ?? '';
  const binding = readCookie(req, BINDING);
  if (!/^[a-f0-9]{64}$/.test(state)) return clearBinding(req, fail('state'));
  const flow = await attempt(env, state, {
    op: 'oauth_flow_take',
    provider,
    // No binding cookie can match no stored digest.
    binding_hash: binding ? await sha(binding) : '0'.repeat(64),
  });
  if (flow.status !== 'ok') return clearBinding(req, fail('state'));
  const to = flow.return_to as string;
  const denied = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (denied || !code)
    return clearBinding(req, fail(denied === 'access_denied' ? 'denied' : 'provider', to));
  let outcome: Outcome | { kind: 'error'; code: string };
  let token = '';
  try {
    const identity = await exchange(provider, app, redirect, code, {
      verifier: flow.verifier,
      nonce: flow.nonce,
    });
    if (flow.intent === 'link')
      outcome = await linkTo(env, identity, flow.account, flow.session_hash);
    else {
      token = randomToken();
      outcome = await signInWith(env, identity, await sha(token));
    }
  } catch (e) {
    if (e instanceof ProviderError) return clearBinding(req, fail(e.reason, to));
    console.error(
      JSON.stringify({
        event: 'oauth.error',
        provider,
        error: String((e as Error)?.message ?? e).slice(0, 120),
      }),
    );
    return clearBinding(req, fail('unavailable', to));
  }
  if (outcome.kind === 'error') return clearBinding(req, fail(outcome.code, to));
  if (outcome.kind === 'linked')
    return clearBinding(req, back(origin, '/settings', { linked: provider }));
  const response = back(origin, to, {});
  response.headers.append(
    'set-cookie',
    sessionCookie(req, `${encodeAccountIdentifier(outcome.username)}.${token}`),
  );
  return clearBinding(req, response);
}

/** The attempt's authority instance (keyed by the state's digest, never the state). */
async function attempt(env: Env, state: string, command: Json): Promise<Json> {
  const stateHash = await sha(state);
  const response = await env.WORKSPACES.get(env.WORKSPACES.idFromName(`oauth:${stateHash}`)).fetch(
    'http://workspace/command',
    { method: 'POST', body: JSON.stringify({ ...command, state_hash: stateHash }) },
  );
  const value = await response.json<Json>();
  if (!response.ok) throw new Error(value.error?.message ?? 'Sign-in attempt failed');
  return value;
}

/** A same-site path to return to after sign-in; anything else is the home page. */
function safePath(value: string | null) {
  if (!value || value.length > 512 || !value.startsWith('/') || /^\/[/\\]/.test(value)) return '/';
  if (/^\/(auth|api)\//.test(value) || !/^[\x21-\x7e]+$/.test(value) || value.includes('\\'))
    return '/';
  return value;
}

function back(origin: string, path: string, params: Record<string, string>) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return redirectTo(url.toString());
}

// No referrer: the callback URL carries the code and state.
const redirectTo = (location: string) =>
  new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });

/** Binds an attempt to the browser that started it. Lax: the callback is a cross-site
 * top-level navigation from the provider. Only the callback path ever receives it. */
function bindingCookie(req: Request, value: string) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${BINDING}=${value}; Path=/auth/; HttpOnly; SameSite=Lax; Max-Age=${value ? 600 : 0}${secure}`;
}

function clearBinding(req: Request, response: Response) {
  response.headers.append('set-cookie', bindingCookie(req, ''));
  return response;
}

function readCookie(req: Request, name: string) {
  const value = req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
