// The account form: sign-up asks for an email address and a password only (the platform
// names the account from the address and keeps the address private); sign-in takes an
// existing username or email address.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountPanel } from './AccountPanel';

const render = (initialMode: 'signup' | 'login') =>
  renderToStaticMarkup(createElement(AccountPanel, { onConnected: () => {}, initialMode }));

describe('account form', () => {
  it('requires an email address to create an account', () => {
    const input = render('signup').match(/<input[^>]*name="email"[^>]*>/)?.[0] ?? '';
    for (const attribute of ['type="email"', 'required=""', 'autoComplete="email"'])
      expect(input).toContain(attribute);
  });

  it('asks for exactly an email address and a password to create an account', () => {
    const names = [...render('signup').matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['email', 'password']);
    expect(render('signup')).not.toContain('Username');
  });

  it('signs in with a username or an email address, and does not ask for a second email', () => {
    const html = render('login');
    const names = [...html.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['username', 'password']);
    expect(html).toContain('Username or email');
  });

  it.each(['signup', 'login'] as const)(
    'opens %s with the terms line linking to both legal pages, once',
    (mode) => {
      const html = render(mode);
      expect(html).toContain('By signing in, you agree to our');
      expect(html.match(/href="\/terms"/g)).toHaveLength(1);
      expect(html.match(/href="\/privacy"/g)).toHaveLength(1);
      expect(html).not.toContain('belong to your account');
      // Right under the heading, before the form.
      expect(html.indexOf('By signing in')).toBeLessThan(html.indexOf('<form'));
    },
  );
});
