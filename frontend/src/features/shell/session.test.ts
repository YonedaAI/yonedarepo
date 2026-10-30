import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { type Session, useSession } from '../../hooks/useSession';
import { api, onUnauthorized } from '../../lib/api';
import { SiteRoot } from '../site/SiteRoot';

vi.mock('../../hooks/useSession', () => ({ useSession: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function signedOut(sessionEnded: boolean): Session {
  return {
    authenticated: false,
    sessionEnded,
    identity: null,
    loading: false,
    error: '',
    setError: vi.fn(),
    discover: vi.fn(),
    signOut: vi.fn(),
    setAvatar: vi.fn(),
  };
}
const count = (html: string, text: string) => html.split(text).length - 1;

describe('ended session', () => {
  it('replaces the workspace with a single sign-in state', () => {
    vi.mocked(useSession).mockReturnValue(signedOut(true));
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Your session ended');
    expect(count(html, 'class="account-tabs"')).toBe(1);
    expect(html).not.toContain('welcome-onboarding');
    expect(html).not.toContain('An API-first, Git-like');
    expect(html).not.toContain('role="alert"');
  });

  it('shows the public home to a visitor who was never signed in, with sign-in a page away', () => {
    vi.mocked(useSession).mockReturnValue(signedOut(false));
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain('Your session ended');
    expect(html).toContain('class="site"');
    expect(html).toContain('href="/signin"');
    const signIn = renderToStaticMarkup(
      createElement(SiteRoot, {
        site: { page: 'signin', mode: 'login' },
        session: signedOut(false),
        navigate: vi.fn(),
      }),
    );
    expect(count(signIn, 'class="account-tabs"')).toBe(1);
    expect(signIn).toContain('<h1 id="signin-heading">Sign in</h1>');
  });

  it('shows no agent-run controls anywhere in the signed-out shell', () => {
    vi.mocked(useSession).mockReturnValue(signedOut(false));
    const html = renderToStaticMarkup(createElement(App));
    for (const gone of ['Connect Agents', 'Start a Run', 'Agent runs', 'Administrator access'])
      expect(html).not.toContain(gone);
  });

  it('reports a rejected session from any API call, but not other failures', async () => {
    const listener = vi.fn();
    const stop = onUnauthorized(listener);
    const reply = (status: number, code: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: { code, message: code } }, { status })),
      );
    reply(403, 'FORBIDDEN');
    await expect(api('repos/r/overview')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listener).not.toHaveBeenCalled();
    reply(401, 'UNAUTHORIZED');
    await expect(api('repos/r/actions', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    await expect(api('repos/r/overview')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
