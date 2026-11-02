// The account form: sign-up asks for an email address and a password only (the platform
// names the account from the address and keeps the address private); sign-in takes an
// existing username or email address.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteSignIn } from '../site/SiteSignIn';
import { AccountPanel } from './AccountPanel';

const render = (initialMode: 'signup' | 'login' | 'forgot') =>
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

  it('puts Forgot password? beside the password and keeps the recovery code below', () => {
    const html = render('login');
    const field = html.match(/<div class="account-password">.*?<\/div>/)?.[0] ?? '';
    expect(field).toContain('>Password</label>');
    // After the input: Tab reaches the password first, and CSS shows it beside the label.
    expect(field.indexOf('name="password"')).toBeLessThan(field.indexOf('Forgot password?'));
    const footer = html.match(/<div class="run-actions">.*<\/div>/)?.[0] ?? '';
    expect(footer).toContain('Use recovery code');
    expect(footer).not.toContain('Forgot password?');
    expect(render('signup')).not.toContain('Forgot password?');
  });

  it('ties the password label to its input', () => {
    const html = render('login');
    const id = html.match(/<label for="([^"]+)">Password/)?.[1];
    expect(html).toContain(`id="${id}"`);
  });

  it('asks a forgotten password for the name or address only, and keeps the recovery code', () => {
    const html = render('forgot');
    const names = [...html.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['username']);
    expect(html).toContain('Reset your password');
    expect(html).toContain('Send reset link');
    expect(html).toContain('Use recovery code');
    expect(html).not.toContain('By signing in');
  });

  it('leaves the heading to a page that has its own', () => {
    const page = (mode: 'login' | 'signup') =>
      renderToStaticMarkup(createElement(SiteSignIn, { mode, onConnected: () => {} }));
    expect(page('login')).toContain('>Sign in</h1>');
    expect(page('signup')).toContain('>Create your account</h1>');
    expect(page('login')).not.toContain('<h2');
    expect(render('login')).toContain('<h2>Sign in</h2>');
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
