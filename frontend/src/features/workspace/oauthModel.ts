// Sign-in with GitHub and Google, as the browser sees it: where each button goes, what a
// returning `auth_error` means in words, and which sign-in methods an account may remove.
// The Worker decides everything; this only names it.
import type { LandingSource } from '../site/landingSource';

export type Provider = 'github' | 'google';
export const PROVIDERS: readonly Provider[] = ['github', 'google'];
export const PROVIDER_LABEL: Record<Provider, string> = { github: 'GitHub', google: 'Google' };

export const isProvider = (value: unknown): value is Provider =>
  PROVIDERS.includes(value as Provider);

/** The Worker route that starts a sign-in (or, signed in, a link) with a provider. */
export function oauthStartUrl(
  provider: Provider,
  options: { intent?: 'link'; returnTo?: string; source?: LandingSource } = {},
) {
  const query = new URLSearchParams();
  if (options.intent) query.set('intent', options.intent);
  else {
    if (options.returnTo && options.returnTo !== '/') query.set('return_to', options.returnTo);
    // A sign-in that creates an account is counted by where its visitor landed from.
    for (const [key, value] of Object.entries(options.source ?? {}))
      if (value) query.set(key, value);
  }
  const search = query.toString();
  return `/auth/${provider}/start${search ? `?${search}` : ''}`;
}

/** What a provider button shows: its own pending state, or disabled while another acts. */
export function providerButton(provider: Provider, pending: Provider | null, busy: boolean) {
  const label = PROVIDER_LABEL[provider];
  return {
    label: pending === provider ? `Redirecting to ${label}…` : `Continue with ${label}`,
    disabled: busy || pending !== null,
    busy: pending === provider,
  };
}

/** The sign-in page's words for a callback's `auth_error`. */
export function authErrorMessage(code: string, provider?: Provider | null) {
  const name = provider ? PROVIDER_LABEL[provider] : 'the provider';
  switch (code) {
    case 'denied':
      return `You cancelled signing in with ${name}. Nothing was changed.`;
    case 'state':
      return 'That sign-in attempt expired or was started in another browser. Try again.';
    case 'provider':
      return `${name} could not confirm the sign-in. Try again in a moment.`;
    case 'unverified_email':
      return `${name} has not verified this account's email address. Verify it with ${name}, or sign in another way.`;
    case 'email_in_use':
      return `An account already uses this ${name} email address. Sign in to that account, then link ${name} in Settings.`;
    case 'identity_taken':
      return `This ${name} account is linked to a different YonedaRepo account. Unlink it there first.`;
    case 'provider_linked':
      return `This account already has a ${name} sign-in. Unlink it first to use another.`;
    case 'session':
      return `Sign in first, then link ${name} from Settings.`;
    case 'rate_limited':
      return 'Too many sign-in attempts. Wait a minute and try again.';
    case 'busy':
      return `Another sign-in with this ${name} account is in progress. Try again in a moment.`;
    default:
      return `Signing in with ${name} is unavailable right now. Try again, or sign in another way.`;
  }
}

export type AuthResult = { error: string } | { linked: Provider };

/** The outcome a provider callback left in the address (`auth_error` or `linked`), if any. */
export function readAuthResult(search: string): AuthResult | null {
  const params = new URLSearchParams(search);
  const error = params.get('auth_error');
  const provider = params.get('auth_provider');
  if (error) return { error: authErrorMessage(error, isProvider(provider) ? provider : null) };
  const linked = params.get('linked');
  return isProvider(linked) ? { linked } : null;
}

/** The address without the callback's outcome parameters (shown once, then dropped). */
export function withoutAuthResult(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  for (const key of ['auth_error', 'auth_provider', 'linked']) params.delete(key);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}`;
}

export type SignInMethods = {
  identities: { provider: string; login: string; email: string | null; created_at: number }[];
  password: boolean;
  providers: string[];
};

/** Whether removing one identity still leaves a way to sign in. */
export const canUnlink = (methods: Pick<SignInMethods, 'identities' | 'password'>) =>
  methods.identities.length + (methods.password ? 1 : 0) > 1;
