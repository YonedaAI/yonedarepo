import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../hooks/useSession';
import { SignInMethodList } from '../account-settings/SignInMethods';
import { SiteRoot } from '../site/SiteRoot';
import { AccountPanel } from './AccountPanel';
import { OAuthButtons } from './OAuthButtons';
import {
  authErrorMessage,
  canUnlink,
  oauthStartUrl,
  type Provider,
  providerButton,
  readAuthResult,
  withoutAuthResult,
} from './oauthModel';

const buttons = (providers: Provider[] | null, pending: Provider | null = null, busy = false) =>
  renderToStaticMarkup(
    createElement(OAuthButtons, { providers, pending, busy, onStart: () => {} }),
  );

describe('provider buttons', () => {
  it('shows each configured provider with its mark, enabled', () => {
    const html = buttons(['github', 'google']);
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('Continue with Google');
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).toContain('fill="#4285F4"'); // Google's own G, not a generic icon
    expect(html).not.toContain('disabled');
    expect(html).toContain('or use a username');
  });

  it('hides a provider the Worker did not report, and shows nothing while loading or when none', () => {
    expect(buttons(['github'])).not.toContain('Google');
    expect(buttons(null)).toBe('');
    expect(buttons([])).toBe('');
  });

  it('marks the pending provider and disables every button while it redirects', () => {
    const html = buttons(['github', 'google'], 'google');
    expect(html).toContain('Redirecting to Google…');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(providerButton('github', 'google', false)).toEqual({
      label: 'Continue with GitHub',
      disabled: true,
      busy: false,
    });
    expect(providerButton('github', null, true).disabled).toBe(true);
  });

  it('the sign-in panel offers providers and links the terms and privacy pages', () => {
    const html = renderToStaticMarkup(
      createElement(AccountPanel, {
        onConnected: () => {},
        initialMode: 'login',
        initialProviders: ['github', 'google'],
      }),
    );
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('By signing in, you agree to our');
    expect(html).toContain('<a href="/terms">Terms of Service</a>');
    expect(html).toContain('<a href="/privacy">Privacy Policy</a>');
    expect(html).not.toContain('role="alert"');
  });

  it('a refused provider sign-in shows its reason in the panel', () => {
    const html = renderToStaticMarkup(
      createElement(AccountPanel, {
        onConnected: () => {},
        initialMode: 'login',
        initialError: authErrorMessage('email_in_use', 'google'),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('An account already uses this Google email address');
  });
});

describe('the public sign-in page', () => {
  it('shows a refused provider sign-in on /signin, with the terms line', () => {
    const session = {
      authenticated: false,
      sessionEnded: false,
      identity: null,
      loading: false,
      error: '',
    } as unknown as Session;
    const html = renderToStaticMarkup(
      createElement(SiteRoot, {
        site: { page: 'signin', mode: 'login' },
        session,
        navigate: () => {},
        signInError: authErrorMessage('denied', 'github'),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('You cancelled signing in with GitHub');
    expect(html).toContain('<a href="/terms">Terms of Service</a>');
  });
});

describe('provider routes and callback outcomes', () => {
  it('starts at the Worker route, returning to where sign-in began', () => {
    expect(oauthStartUrl('github')).toBe('/auth/github/start');
    expect(oauthStartUrl('google', { returnTo: '/device?code=BCDF-GHJK' })).toBe(
      '/auth/google/start?return_to=%2Fdevice%3Fcode%3DBCDF-GHJK',
    );
    expect(oauthStartUrl('google', { intent: 'link', returnTo: '/x' })).toBe(
      '/auth/google/start?intent=link',
    );
  });

  it('names each error state in words', () => {
    expect(readAuthResult('?auth_error=denied&auth_provider=github')).toEqual({
      error: 'You cancelled signing in with GitHub. Nothing was changed.',
    });
    expect(authErrorMessage('state')).toMatch(/expired or was started in another browser/);
    expect(authErrorMessage('provider', 'google')).toMatch(/^Google could not confirm/);
    expect(authErrorMessage('email_in_use', 'github')).toMatch(/link GitHub in Settings/);
    expect(authErrorMessage('unverified_email', 'google')).toMatch(/not verified/);
    expect(authErrorMessage('something-new', 'github')).toMatch(/unavailable right now/);
    expect(readAuthResult('?linked=google')).toEqual({ linked: 'google' });
    expect(readAuthResult('?linked=gitlab')).toBeNull();
    expect(readAuthResult('?code=BCDF')).toBeNull();
    expect(withoutAuthResult('/device', '?code=X&auth_error=denied&auth_provider=github')).toBe(
      '/device?code=X',
    );
  });
});

describe('sign-in methods in settings', () => {
  const github = { provider: 'github', login: 'octocat', email: 'o@example.com', created_at: 1 };
  const google = { provider: 'google', login: 'o', email: 'o@example.com', created_at: 2 };
  const list = (
    identities: (typeof github)[],
    password: boolean,
    providers = ['github', 'google'],
  ) =>
    renderToStaticMarkup(
      createElement(SignInMethodList, {
        methods: { identities, password, providers },
        busy: false,
        onLink: () => {},
        onUnlink: () => {},
      }),
    );

  it('never offers to unlink the last way to sign in', () => {
    expect(canUnlink({ identities: [github], password: false })).toBe(false);
    expect(canUnlink({ identities: [github], password: true })).toBe(true);
    expect(canUnlink({ identities: [github, google], password: false })).toBe(true);
    const only = list([github], false);
    expect(only).toMatch(
      /aria-label="Unlink GitHub"[^>]*disabled=""|disabled=""[^>]*aria-label="Unlink GitHub"/,
    );
    expect(only).toContain('This is your only way to sign in');
    expect(only).toContain('Link Google');
    const both = list([github, google], false);
    expect(both).not.toContain('disabled=""');
    expect(both).not.toContain('Link ');
  });

  it('offers only configured providers for linking', () => {
    expect(list([], true, ['github'])).toContain('Link GitHub');
    expect(list([], true, ['github'])).not.toContain('Link Google');
    expect(list([], true, [])).toContain('This account uses a password');
  });
});
