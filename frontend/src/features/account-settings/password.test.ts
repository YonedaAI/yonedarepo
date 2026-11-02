// A forgotten password in the browser: the emailed link's route (its token never comes back out
// of the route), the reset page, and Settings' new recovery code.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSourceRoute, parseSourceRoute } from '../source-platform/sourceRoute';
import { RecoveryDialog, RecoveryRow } from './RecoverySettings';
import { ResetPasswordPage } from './ResetPasswordPage';

const token = 'ab'.repeat(32);
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const noop = () => {};

describe('reset page route', () => {
  it('reads the link from the fragment and never writes the token back', () => {
    const route = parseSourceRoute(
      '/reset-password',
      '',
      `#account=ada%40example.com&token=${token}`,
    );
    expect(route).toEqual({ view: 'reset-password', account: 'ada@example.com', token });
    expect(formatSourceRoute(route)).toBe('/reset-password');
  });

  it('ignores a token in the query', () => {
    expect(parseSourceRoute('/reset-password', `?account=ada&token=${token}`)).toEqual({
      view: 'reset-password',
      account: '',
      token: '',
    });
  });
});

describe('reset page', () => {
  const page = () => render(createElement(ResetPasswordPage, { account: 'ada', token }));

  it('asks for a new password of at least 12 characters', () => {
    const html = page();
    const input = html.match(/<input[^>]*name="password"[^>]*>/)?.[0] ?? '';
    for (const attribute of [
      'type="password"',
      'required=""',
      'minLength="12"',
      'maxLength="128"',
      'autoComplete="new-password"',
    ])
      expect(input).toContain(attribute);
    expect(html).toContain('At least 12 characters.');
    expect(html).toContain('This also revokes every token and CLI sign-in.');
  });

  it('gives a password manager the account, and never prints the token', () => {
    const html = page();
    expect(html).toMatch(/<input[^>]*autoComplete="username"[^>]*value="ada"/);
    expect(html).not.toContain(token);
  });

  it('explains an incomplete link and offers the way out', () => {
    const html = render(createElement(ResetPasswordPage, { account: '', token: '' }));
    expect(html).not.toContain('<form');
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/signin"');
  });
});

describe('recovery code in Settings', () => {
  it('offers to regenerate it', () => {
    const html = render(createElement(RecoveryRow, { onRegenerate: noop }));
    expect(html).toContain('aria-label="Regenerate recovery code"');
  });

  it('warns before replacing the code', () => {
    const html = render(
      createElement(RecoveryDialog, {
        code: '',
        busy: false,
        error: '',
        onConfirm: noop,
        onClose: noop,
      }),
    );
    expect(html).toContain('old code stops working');
  });

  it('shows the new code once, with a way to copy it', () => {
    const html = render(
      createElement(RecoveryDialog, {
        code: 'cd'.repeat(32),
        busy: false,
        error: '',
        onConfirm: noop,
        onClose: noop,
      }),
    );
    expect(html).toContain('cd'.repeat(32));
    expect(html).toContain('shown once');
    expect(html).toContain('Copy recovery code');
    expect(html).toContain('I saved it');
  });
});
