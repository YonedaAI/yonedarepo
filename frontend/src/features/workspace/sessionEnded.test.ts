import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { useRepository } from '../../hooks/useRepository';
import { api, onUnauthorized } from '../../lib/api';

vi.mock('../../hooks/useRepository', () => ({ useRepository: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function signedOut(sessionEnded: boolean) {
  return {
    authenticated: false,
    sessionEnded,
    identity: null,
    repositories: [],
    snapshot: null,
    project: undefined,
    id: '',
    loading: false,
    // A late child request can still report the rejection after the workspace was cleared.
    error: 'Sign in to your workspace',
    refresh: vi.fn(),
    discover: vi.fn(),
    setError: vi.fn(),
    setId: vi.fn(),
  } as unknown as ReturnType<typeof useRepository>;
}
const count = (html: string, text: string) => html.split(text).length - 1;

describe('ended session', () => {
  it('replaces the workspace with a single sign-in state', () => {
    vi.mocked(useRepository).mockReturnValue(signedOut(true));
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Your session ended');
    expect(count(html, 'class="account-tabs"')).toBe(1);
    expect(html).toContain('Have a reviewer access key?');
    expect(html).not.toContain('welcome-onboarding');
    expect(html).not.toContain('An API-first, Git-like');
    expect(html).not.toContain('role="alert"');
  });

  it('keeps the ordinary welcome for a visitor who was never signed in', () => {
    vi.mocked(useRepository).mockReturnValue(signedOut(false));
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain('Your session ended');
    expect(html).toContain('welcome-onboarding');
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
