// The account form: sign-up asks for a contact email (the welcome email's address); sign-in
// does not.
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

  it('does not ask for one to sign in', () => {
    expect(render('login')).not.toContain('name="email"');
  });
});
