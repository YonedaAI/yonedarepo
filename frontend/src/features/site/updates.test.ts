// The Flight log's page and the closing band that leads to it: its addresses, what the form
// refuses before it asks the platform, and the words the owner asked for on the home page.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSourceRoute, parseSourceRoute } from '../source-platform/sourceRoute';
import { SiteHome } from './SiteHome';
import { formProblem, SignUpForm, SiteUpdates, SiteUpdatesLink } from './SiteUpdates';
import { seoManifest } from './seo';

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

describe('the Flight log addresses', () => {
  it('parses the page and the emailed links, and keeps the token through a format', () => {
    expect(parseSourceRoute('/updates', '')).toEqual({ view: 'site', site: { page: 'updates' } });
    const link = parseSourceRoute('/updates/confirm', '?token=abc');
    expect(link).toEqual({
      view: 'site',
      site: { page: 'updates-link', action: 'confirm', token: 'abc' },
    });
    expect(formatSourceRoute(link)).toBe('/updates/confirm?token=abc');
    expect(parseSourceRoute('/updates/unsubscribe', '?token=1.ab')).toEqual({
      view: 'site',
      site: { page: 'updates-link', action: 'unsubscribe', token: '1.ab' },
    });
  });

  it('leaves anything else under /updates to the app, never a profile', () => {
    expect(parseSourceRoute('/updates/other', '')).toEqual({ view: 'home' });
  });

  it('lists the page for search engines, and no emailed link', () => {
    const paths = seoManifest().routes.map((route) => route.path);
    expect(paths).toContain('/updates');
    expect(paths.filter((path) => path.startsWith('/updates/'))).toEqual([]);
  });
});

describe('the form', () => {
  it('asks for a valid address first, then the ticked box', () => {
    expect(formProblem('nobody', true)?.field).toBe('email');
    expect(formProblem('nobody', false)?.field).toBe('email');
    expect(formProblem('=x@example.com', true)?.field).toBe('email');
    expect(formProblem('ada@example.com', false)?.field).toBe('consent');
    expect(formProblem(' Ada@Example.com ', true)).toBeNull();
  });

  it('asks for an email address and consent, and nothing else, with the box unticked', () => {
    const form = render(createElement(SignUpForm, { onSent: () => {} }));
    const inputs = form.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain('type="email"');
    expect(inputs[1]).toContain('type="checkbox"');
    expect(inputs[1]).not.toContain('checked');
  });

  it('shows no form before the platform says it is open', () => {
    const page = render(createElement(SiteUpdates));
    expect(page).toContain('Flight log');
    expect(page).not.toContain('<form');
  });

  it('acts on an emailed link only by its button, and says when the link is incomplete', () => {
    const props = { action: 'confirm' as const, navigate: () => {} };
    expect(render(createElement(SiteUpdatesLink, { ...props, token: 'abc' }))).toContain(
      'type="submit"',
    );
    const incomplete = render(createElement(SiteUpdatesLink, { ...props, token: '' }));
    expect(incomplete).toContain('invalid, used or expired');
    expect(incomplete).not.toContain('<form');
  });
});

describe('what the list sends', () => {
  const page = render(createElement(SiteUpdates));

  it('names its three kinds of email under the form', () => {
    expect(page.match(/<h2>/g)).toHaveLength(3);
    for (const title of ['What we shipped', 'What’s new to try', 'How it was built'])
      expect(page).toContain(title);
  });

  it('promises no schedule and no early access', () => {
    expect(page.toLowerCase()).not.toMatch(
      /early access|every (week|month|release)|weekly|monthly/,
    );
  });

  it('stays off the pages an emailed link opens', () => {
    const link = createElement(SiteUpdatesLink, {
      action: 'confirm',
      token: 'abc',
      navigate: () => {},
    });
    expect(render(link)).not.toContain('site-updates-sent');
  });
});

describe('the closing band', () => {
  const home = render(createElement(SiteHome, { navigate: () => {} }));

  it('leads to the Flight log and keeps Get started', () => {
    const band = home.slice(home.indexOf('site-band-cta'));
    expect(band).toMatch(/href="\/updates"[^>]*>Get updates/);
    expect(band).toMatch(/href="\/signup"[^>]*>Get started/);
  });

  it('says it in plain words', () => {
    expect(home).toContain('Works with Git, our CLI and any MCP client.');
    expect(home).not.toContain('The platform is free.');
    expect(home).not.toContain('stock Git, the CLI or MCP');
  });
});
