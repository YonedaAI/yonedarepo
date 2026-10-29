// The public site: its routes, the nav, the pricing table and every docs, blog and company
// content file.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import usageSource from '../../../../backend/crates/yoneda-cli/src/command/usage.rs?raw';
import tools from '../../../../backend/crates/yoneda-core/src/platform_tools.json';
import transcriptSource from '../../../../backend/crates/yoneda-core/src/transcript.rs?raw';
import scanSource from '../../../../backend/crates/yoneda-platform/src/secret_scan.rs?raw';
import {
  AGENT_MARGIN,
  CONTAINER_USD_PER_MINUTE,
  MANAGED_AGENTS,
  STARTING_CREDIT_USD,
} from '../../../../shared/managed-agents';
import { nextTheme, THEMES } from '../shell/theme';
import { formatSourceRoute, parseSourceRoute } from '../source-platform/sourceRoute';
import { BLOG_POSTS, COMPANY_PAGES, DOCS_NAV, DOCS_PAGES, LEGAL_PAGES } from './content';
import { FEATURES } from './features';
import {
  agentUsageRows,
  formatUsd,
  MARGIN,
  METERS,
  meterPrice,
  PRICING,
  roundUpClean,
} from './pricing';
import { SiteFeatures } from './SiteFeatures';
import { SiteHome } from './SiteHome';
import { SiteLayout } from './SiteLayout';
import { SiteBlog, SiteCompany, SiteDocs, SiteLegal } from './SitePages';
import { SitePricing } from './SitePricing';
import { siteView } from './siteRoute';

const navigate = () => {};
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const parse = (path: string) => parseSourceRoute(path, '');

describe('site routes', () => {
  it.each([
    ['/features', { page: 'features' }],
    ['/pricing', { page: 'pricing' }],
    ['/docs', { page: 'docs', slug: 'get-started' }],
    ['/docs/guides/changes', { page: 'docs', slug: 'guides/changes' }],
    ['/blog', { page: 'blog' }],
    ['/blog/search-v4', { page: 'post', slug: 'search-v4' }],
    ['/company', { page: 'about' }],
    ['/company/about', { page: 'about' }],
    ['/company/vision', { page: 'vision' }],
    ['/signin', { page: 'signin', mode: 'login' }],
    ['/signup', { page: 'signin', mode: 'signup' }],
    ['/terms', { page: 'legal', doc: 'terms' }],
    ['/privacy', { page: 'legal', doc: 'privacy' }],
  ])('%s parses to a site page and formats back', (path, site) => {
    const route = parse(path);
    expect(route).toEqual({ view: 'site', site });
    const canonical = path === '/company' ? '/company/about' : path;
    expect(formatSourceRoute(route)).toBe(path === '/docs' ? '/docs' : canonical);
  });

  it('leaves the app routes and unknown paths as they were', () => {
    expect(parse('/')).toEqual({ view: 'home' });
    expect(parse('/nowhere')).toEqual({ view: 'home' });
    expect(parse('/settings')).toEqual({ view: 'settings' });
    expect(parse('/source/explore')).toEqual({ view: 'explore' });
  });

  it('shows the public home at / only to a signed-out visitor', () => {
    const home = { view: 'home' } as const;
    const out = { authenticated: false, loading: false, sessionEnded: false };
    expect(siteView(home, out, false)).toEqual({ page: 'home' });
    expect(siteView(home, { ...out, authenticated: true }, true)).toBeUndefined();
    // While the session loads, a browser that was signed in last time waits in the app.
    expect(siteView(home, { ...out, loading: true }, true)).toBeUndefined();
    expect(siteView(home, { ...out, loading: true }, false)).toEqual({ page: 'home' });
    expect(siteView(home, { ...out, sessionEnded: true }, false)).toBeUndefined();
    expect(siteView({ view: 'site', site: { page: 'pricing' } }, out, false)).toEqual({
      page: 'pricing',
    });
    expect(siteView({ view: 'settings' }, out, false)).toBeUndefined();
  });
});

describe('site nav', () => {
  it('links every section, sign in and get started to site routes', () => {
    const html = render(
      createElement(SiteLayout, { page: { page: 'home' }, authenticated: false, navigate }, 'x'),
    );
    for (const [label, href] of [
      ['Features', '/features'],
      ['Pricing', '/pricing'],
      ['Docs', '/docs'],
      ['Blog', '/blog'],
      ['Company', '/company/about'],
      ['Sign in', '/signin'],
      ['Get started', '/signup'],
    ]) {
      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(`>${label}<`);
      expect(parse(href).view).toBe('site');
    }
    expect(html).toContain('Yoneda Labs');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toMatch(/<button[^>]*aria-label="Theme: System[^"]*"/);
  });

  it('cycles the theme System → Light → Dark → System', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['system', 'light', 'dark']);
    expect(['system', 'light', 'dark'].map((t) => nextTheme(t as never))).toEqual([
      'light',
      'dark',
      'system',
    ]);
  });

  it('offers the app instead of sign-in when signed in', () => {
    const html = render(
      createElement(SiteLayout, { page: { page: 'pricing' }, authenticated: true, navigate }, 'x'),
    );
    expect(html).toContain('Open app');
    expect(html).not.toContain('>Sign in<');
    expect(html).toContain('aria-current="page"');
  });
});

describe('pricing', () => {
  it('rounds cost × margin up to two significant figures', () => {
    expect(MARGIN).toBe(1.3);
    expect(roundUpClean(0.0016037)).toBe(0.0017);
    expect(roundUpClean(0.26)).toBe(0.26);
    expect(roundUpClean(0.6695)).toBe(0.67);
    expect(roundUpClean(0.0195)).toBe(0.02);
    expect(formatUsd(0.0017)).toBe('$0.0017');
    expect(formatUsd(5)).toBe('$5');
    expect(formatUsd(0.2)).toBe('$0.20');
  });

  it('prices each meter at or above its Cloudflare cost', () => {
    for (const meter of METERS) {
      expect(meterPrice(meter)).toBeGreaterThanOrEqual(meter.cost * MARGIN);
      expect(meter.basis.length).toBeGreaterThan(0);
    }
    expect(METERS.filter((m) => m.id === 'check-minutes').map(meterPrice)).toEqual([0.0017]);
  });

  it('renders every rate, allowance, the credit and the preview label', () => {
    const html = render(createElement(SitePricing, { navigate }));
    expect(html).toContain('Preview pricing');
    for (const meter of METERS) {
      expect(html).toContain(meter.label);
      expect(html).toContain(formatUsd(meterPrice(meter)));
      if (meter.included) expect(html).toContain(meter.included);
    }
    expect(html).toContain(formatUsd(PRICING.startingCreditUsd));
    expect(html).toContain(formatUsd(PRICING.topUp.belowUsd));
    expect(html).toContain(formatUsd(PRICING.topUp.addUsd));
    expect(html).toContain('Enterprise');
    expect(html).toContain('href="mailto:privacy@yonedarepo.com"');
    expect(html).not.toMatch(/buy now|add (a )?card now|pay now/i);
  });

  it('prices agent usage at the provider rate × the same margin, from one credit', () => {
    expect(AGENT_MARGIN).toBe(MARGIN);
    expect(PRICING.startingCreditUsd).toBe(STARTING_CREDIT_USD);
    const rows = agentUsageRows();
    for (const agent of MANAGED_AGENTS)
      expect(
        rows.some(
          (r) => r.model === agent.defaults.model && r.agents.includes(agent.defaults.name),
        ),
      ).toBe(true);
    for (const row of rows) {
      expect(row.input_price).toBeCloseTo(row.input * MARGIN, 6);
      expect(row.output_price).toBeCloseTo(row.output * MARGIN, 6);
    }
    const glm = rows.find((r) => r.model === 'glm-5.3-flash');
    expect(glm).toMatchObject({ input_price: 0.195, output_price: 0.65 });
    const html = render(createElement(SitePricing, { navigate }));
    expect(html).toContain('Agent usage: pay as you go');
    for (const row of rows) {
      expect(html).toContain(row.label);
      expect(html).toContain(formatUsd(row.output_price));
    }
    expect(html).toContain(`${formatUsd(CONTAINER_USD_PER_MINUTE)} a`);
    expect(html).toContain('agents pause at a $0');
  });
});

describe('content', () => {
  it('lists every docs file in the nav, and every nav entry has a file', () => {
    const navSlugs = DOCS_NAV.flatMap((s) => s.pages);
    expect(new Set(navSlugs).size).toBe(navSlugs.length);
    expect([...navSlugs].sort()).toEqual(Object.keys(DOCS_PAGES).sort());
  });

  it.each(Object.keys(DOCS_PAGES))('renders docs page %s', (slug) => {
    const page = DOCS_PAGES[slug];
    const html = render(createElement(SiteDocs, { slug, navigate }));
    expect(page.title).not.toBe('');
    expect(html).toContain(`<h1`);
    expect(html).toContain(escapeHtml(page.title));
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('](');
  });

  it('keeps the CLI reference in step with the CLI usage text', () => {
    const usage = /USAGE: &str = "\\\n([\s\S]*?)";/.exec(usageSource)?.[1] ?? '';
    const lines = usage.split('\n').filter((line) => line.trim() && !line.startsWith('usage:'));
    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) expect(DOCS_PAGES['reference/cli'].body).toContain(line);
  });

  it('lists every MCP tool in the API reference', () => {
    for (const tool of tools)
      expect(DOCS_PAGES['reference/api'].body).toContain(`\`${tool.name}\``);
  });

  it('answers an unknown docs page with a not-found heading', () => {
    expect(render(createElement(SiteDocs, { slug: 'nope', navigate }))).toContain('not found');
  });

  it.each(BLOG_POSTS.map((p) => p.slug))('renders blog post %s', (slug) => {
    const [post] = BLOG_POSTS.filter((p) => p.slug === slug);
    expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const html = render(createElement(SiteBlog, { slug, navigate }));
    expect(html).toContain(escapeHtml(post.title));
    expect(html).toContain(`dateTime="${post.date}"`);
    expect(html).not.toContain('](');
  });

  it('lists every post, newest first, on the blog index', () => {
    expect(BLOG_POSTS.length).toBeGreaterThanOrEqual(2);
    const dates = BLOG_POSTS.map((p) => p.date);
    expect(dates).toEqual([...dates].sort().reverse());
    const html = render(createElement(SiteBlog, { navigate }));
    for (const post of BLOG_POSTS) expect(html).toContain(`href="/blog/${post.slug}"`);
  });

  it.each(['about', 'vision'] as const)('renders the company %s page', (page) => {
    expect(COMPANY_PAGES[page].title).not.toBe('');
    const html = render(createElement(SiteCompany, { page, navigate }));
    expect(html).toContain('<h1');
    expect(html).not.toContain('](');
  });

  it.each(['terms', 'privacy'] as const)('renders %s as a draft pending legal review', (doc) => {
    expect(LEGAL_PAGES[doc].status).toBe('Draft, pending legal review');
    const html = render(createElement(SiteLegal, { doc, navigate }));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Draft, pending legal review');
    expect(html).toContain('Yoneda Labs');
    expect(html).toContain('YonedaRepo');
    expect(html).toContain('href="mailto:privacy@yonedarepo.com"');
    expect(html).not.toMatch(/governing law|\bvenue\b|will be (set|published)|minimum age/i);
    expect(html).not.toContain('](');
  });

  it('renders the home and features pages with one h1 each', () => {
    for (const el of [
      createElement(SiteHome, { navigate }),
      createElement(SiteFeatures, { navigate }),
    ]) {
      const html = render(el);
      expect(html.match(/<h1/g)).toHaveLength(1);
    }
  });
});

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll("'", '&#x27;');

// Claims about transcripts follow what the platform does, read from its own sources: once
// `git_session_record` stores transcripts, no page may call them coming or unstored, and the
// limits the pages quote must be the stored ones.
describe('transcript claims', () => {
  const stores = tools.some(
    (t) => t.name === 'git_session_record' && /transcript the platform stores/.test(t.description),
  );
  const pages = [
    ...Object.entries(DOCS_PAGES).map(([slug, p]) => [`docs/${slug}`, p.body] as const),
    ...Object.entries(LEGAL_PAGES).map(([doc, p]) => [doc, p.body] as const),
    ...FEATURES.map(
      (f) => [`feature ${f.id}`, JSON.stringify([f.points, f.coming ?? ''])] as const,
    ),
  ];

  it('never calls stored transcripts coming or unstored', () => {
    expect(stores).toBe(true);
    const stale =
      /transcripts?\b[^.|]*\b(coming|in progress|not (yet )?stored|does not store|never stored)|(coming|in progress)[^.|]*\btranscripts?/i;
    for (const [name, text] of pages) expect(`${name}: ${stale.test(text)}`).toBe(`${name}: false`);
    expect(FEATURES.find((f) => f.id === 'sessions')?.coming).toBeUndefined();
  });

  it('quotes the stored limits and the redaction rule count from the source', () => {
    const block =
      /pub const STORED: Limits = Limits \{([\s\S]*?)\};/.exec(transcriptSource)?.[1] ?? '';
    expect(block).toMatch(/total: 1024 \* 1024,/);
    expect(block).toMatch(/turns: 2_000,/);
    const rules = /pub const RULES: \[&str; (\d+)\]/.exec(scanSource)?.[1];
    expect(rules).toBe('11');
    for (const text of [LEGAL_PAGES.privacy.body, DOCS_PAGES['guides/sessions'].body]) {
      expect(text).toContain('1 MiB');
      expect(text).toContain('2,000 turns');
      expect(text).toContain(`${rules} rules`);
      expect(text).toContain('[REDACTED:');
    }
  });
});
