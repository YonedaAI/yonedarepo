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
import { LEGAL_ENTITY } from '../../content/legal/entity';
import { nextTheme, THEMES } from '../shell/theme';
import { formatSourceRoute, parseSourceRoute } from '../source-platform/sourceRoute';
import { BUILD_ON, mockOf, pickActive } from './buildOn';
import {
  BLOG_POSTS,
  COMPANY_PAGES,
  DOCS_NAV,
  DOCS_PAGES,
  LEGAL_PAGES,
  LEGAL_SOURCES,
} from './content';
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
import { COMPARISONS } from './SiteCompare';
import { SiteFeatures } from './SiteFeatures';
import { checkHealth, FOOTER_COLUMNS, SOCIAL_LINKS, StatusPill } from './SiteFooter';
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

describe('home', () => {
  const home = () => render(createElement(SiteHome, { navigate }));

  it('tours every Build on YonedaRepo feature: a nav item, its panel and a visual', () => {
    const html = home();
    expect(BUILD_ON.map((b) => [b.title, b.subtitle])).toEqual([
      ['Code as Transactions', 'Every commit lands, first try'],
      ['Global by default', 'One network, no regions to pick'],
      ['Git hosting', 'Stock Git, nothing new to learn'],
      ['Fetch only what you need', 'Clone in seconds, load files on demand'],
      ['Changes & gates', 'Ship when every gate is green'],
      ['Continuous integration', 'Checks that keep pace with agents'],
      ['Review agents', 'Code, security and slop review on tap'],
      ['Continuous Memory', 'Every agent picks up where the last one left off'],
      ['Code search', 'Search, blame and history, no clone'],
    ]);
    expect(BUILD_ON.find((b) => b.id === 'memory')?.feature).toBe('sessions');
    expect(html).toContain('Build on YonedaRepo.');
    expect(html).toContain('aria-label="Build on YonedaRepo"');
    expect(new Set(BUILD_ON.map((b) => b.id)).size).toBe(BUILD_ON.length);
    for (const item of BUILD_ON) {
      expect(html).toContain(`href="#build-${item.id}"`);
      expect(html).toContain(`id="build-${item.id}"`);
      expect(html).toContain(escapeHtml(item.title));
      expect(mockOf(item)).toBeTruthy();
      if (item.feature) {
        expect(FEATURES.map((f) => f.id)).toContain(item.feature);
        expect(html).toContain(`href="/features#${item.feature}"`);
      }
    }
    // The first item is current before any scrolling, and only one is.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain(`href="#build-${BUILD_ON[0].id}" aria-current="true"`);
  });

  it('lists each problem struck through, with a chip linking to the tour panel that solves it', () => {
    const html = home();
    expect(html).toContain('Git wasn’t built for a thousand writers');
    const rows = [
      ...html.matchAll(
        /<s>([^<]+)<\/s>[\s\S]*?<a class="site-chip" href="#build-([^"]+)">([^<]+)<\/a>/g,
      ),
    ];
    expect(rows).toHaveLength(5);
    for (const [, , panel, chip] of rows)
      expect(BUILD_ON.find((b) => b.id === panel)?.title).toBe(chip.replace('&amp;', '&'));
  });

  it('highlights the first panel in page order that is in view', () => {
    const order = BUILD_ON.map((b) => b.id);
    expect(pickActive(order, new Set(['code', 'git-hosting']), 'transactions')).toBe('git-hosting');
    expect(pickActive(order, new Set(), 'context')).toBe('context');
  });

  it('names every managed review agent the platform runs', () => {
    const html = home();
    for (const agent of MANAGED_AGENTS) expect(html).toContain(agent.defaults.name);
  });

  it('compares with plain Git using only measured figures, and no internal test details', () => {
    const html = home();
    expect(COMPARISONS.map((c) => c.id)).toContain('first-try');
    for (const c of COMPARISONS) {
      expect(html).toContain(escapeHtml(c.question));
      expect(html).toContain(c.ours.label);
      expect(html).toContain(`${c.theirs.name}</dt>`);
      expect(html).toContain(c.theirs.label);
    }
    expect(html).not.toMatch(
      /measured|promised|development environment|\bp95\b|how we test|not yet shown|\b20\d\d-\d\d-\d\d\b/i,
    );
  });

  it('names other products only in the works-with strip, and nothing as coming', () => {
    const html = home();
    const strips = [...html.matchAll(/<ul class="site-works-with"[^>]*>[\s\S]*?<\/ul>/g)].map(
      (m) => m[0],
    );
    // The marquee renders the list twice; only the first copy is read aloud.
    expect(strips).toHaveLength(2);
    expect(strips[0]).toContain('aria-label="Agents YonedaRepo works with"');
    expect(strips[1]).toContain('aria-hidden="true"');
    // Nominative "works with": real marks, each named, at least the agents we test against.
    for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Any Git client'])
      expect(strips[0]).toContain(`role="img" aria-label="${name}"`);
    expect(strips[0]).not.toContain('site-works-chip');
    const rest = strips.reduce((page, strip) => page.replace(strip, ''), html);
    expect(rest).not.toMatch(
      /anthropic|claude|scion|openai|codex|opencode|cursor|gemini|copilot|(?<!&)\bamp\b|cline|\bglm|mimo|github|gitlab|cloudflare|coming soon/i,
    );
  });
});

describe('footer', () => {
  const layout = () =>
    render(
      createElement(SiteLayout, { page: { page: 'home' }, authenticated: false, navigate }, 'x'),
    );

  it('links only to routes and sections that exist', () => {
    const links = FOOTER_COLUMNS.flatMap((c) => c.links);
    expect(FOOTER_COLUMNS.map((c) => c.title)).toEqual(['Product', 'Company', 'Legal', 'Connect']);
    const html = layout();
    for (const link of links) {
      if ('href' in link) {
        expect(link.href).toMatch(/^(mailto:|https:\/\/)/);
        expect(html).toContain(`href="${link.href}"`);
        continue;
      }
      const path = formatSourceRoute(link.route);
      expect(parse(path)).toEqual(link.route);
      expect(html).toContain(`href="${path}${link.hash ? `#${link.hash}` : ''}"`);
      if (!link.hash) continue;
      // The anchor is a real section of the page it points to.
      const target =
        link.route.view === 'home'
          ? render(createElement(SiteHome, { navigate }))
          : link.route.view === 'site' && link.route.site.page === 'legal'
            ? render(createElement(SiteLegal, { doc: link.route.site.doc, navigate }))
            : render(createElement(SiteFeatures, { navigate }));
      expect(target).toContain(`id="${link.hash}"`);
    }
  });

  it('lists the set public profiles in order, each opening in a new tab', () => {
    const connect = FOOTER_COLUMNS.find((c) => c.title === 'Connect')?.links ?? [];
    expect(connect.map((l) => l.label)).toEqual(
      SOCIAL_LINKS.filter((s) => s.url).map((s) => s.label),
    );
    expect(connect.map((l) => l.label)).toEqual([
      'GitHub',
      'X',
      'LinkedIn',
      'YouTube',
      'Discord',
      'Email us',
    ]);
    const html = layout();
    for (const { url } of SOCIAL_LINKS.filter((s) => s.url))
      expect(html).toContain(
        url.startsWith('mailto:')
          ? `href="${url}">`
          : `href="${url}" target="_blank" rel="noopener noreferrer"`,
      );
  });

  it('shows the copyright with the legal name and this year', () => {
    expect(layout()).toContain(`© ${new Date().getFullYear()} ${LEGAL_ENTITY.legalName}`);
  });

  it('reports the front health: operational, degraded, or nothing while it loads', async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await checkHealth(answer(200, { service: 'yonedarepo', v: 1 }))).toBe('operational');
    expect(await checkHealth(answer(503, { service: 'yonedarepo' }))).toBe('degraded');
    expect(await checkHealth(answer(200, { service: 'other' }))).toBe('degraded');
    const failing = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await checkHealth(failing)).toBe('degraded');
    // A slow answer is cut off and counts as degraded.
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(await checkHealth(slow, 10)).toBe('degraded');

    expect(render(createElement(StatusPill, { health: null }))).toBe('');
    const ok = render(createElement(StatusPill, { health: 'operational' }));
    expect(ok).toContain('site-status-operational');
    expect(ok).toContain('Operational');
    const down = render(createElement(StatusPill, { health: 'degraded' }));
    expect(down).toContain('site-status-degraded');
    expect(down).toContain('Degraded');
    // The footer never states a status before the check answers.
    expect(layout()).not.toMatch(/Operational|Degraded/);
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

  const LEGAL_SECTIONS = {
    privacy: [
      'What we collect',
      'How we use it',
      'Where it is stored',
      'How long we keep it',
      'Your choices and deletion',
      'When we disclose it',
      'Security',
      'Service providers',
      'Cookies',
      'Links to other sites',
      'Rights in the EEA and the UK',
      'Rights in US states',
      'Children',
      'Changes to this policy',
      'Contact',
    ],
    terms: [
      'Who may use YonedaRepo',
      'Your account and its security',
      'Your content',
      'Acceptable use and limits',
      'Credit and fees',
      'Backups',
      'Third-party integrations',
      'Copyright complaints',
      'Our intellectual property',
      'Feedback',
      'Links to other sites',
      'Suspension and termination',
      'Disclaimers',
      'Limitation of liability',
      'Indemnification',
      'Disputes',
      'Export and sanctions',
      'Changes to these terms',
      'General',
      'Contact',
    ],
  };

  it.each(['terms', 'privacy'] as const)(
    'renders %s with every section, a contents list, the date and the legal address',
    (doc) => {
      const html = render(createElement(SiteLegal, { doc, navigate }));
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain('YonedaRepo');
      expect(html).toContain('href="mailto:legal@yonedarepo.com"');
      expect(html).toContain(`Last updated <time dateTime="${LEGAL_ENTITY.lastUpdated}"`);
      const headings = [...LEGAL_PAGES[doc].body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(headings).toEqual(LEGAL_SECTIONS[doc]);
      for (const title of headings) {
        const id = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        expect(html).toContain(`href="#${id}"`);
        expect(html).toContain(`id="${id}"`);
      }
      expect(html).not.toContain('](');
      expect(html).not.toContain('{{');
    },
  );

  it('fills every company fact the legal pages use, so none ships as a gap', () => {
    const used = new Set(
      Object.values(LEGAL_SOURCES).flatMap((source) =>
        [...source.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]),
      ),
    );
    expect([...used].filter((name) => !(name in LEGAL_ENTITY))).toEqual([]);
    const missing = Object.entries(LEGAL_ENTITY)
      .filter(([, value]) => !String(value).trim())
      .map(([name]) => name);
    expect(missing).toEqual([]);
    expect(LEGAL_ENTITY.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

// The site's palette, read from site.css on disk (Vitest empties a `?raw` stylesheet import,
// and the browser tsconfig has no Node types, hence the untyped dynamic import): app components on site pages (the sign-in panel's
// buttons) paint --blue behind --on-accent, so both must map to the site's accent pair, and
// every text pair the site uses must reach WCAG AA in both themes.
describe('site palette', async () => {
  const fs = await import(`node:${'fs'}`);
  const read = (name: string): string =>
    fs.readFileSync(new URL(`../../styles/${name}`, import.meta.url), 'utf8');
  const siteCss = read('site.css');
  const themeCss = read('theme.css');
  const block = (selector: string, css = siteCss) => {
    const at = css.indexOf(selector);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return Object.fromEntries(
      [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
    );
  };
  const light = block('.site {');
  const dark = block(':root[data-theme="dark"] .site {');
  const hex = (value: string) => {
    const h = value.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
  };
  const lum = (value: string) => {
    const [r, g, b] = hex(value).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('maps the app button pair to the site accent pair', () => {
    expect(light.blue).toBe('var(--site-accent)');
    expect(light['on-accent']).toBe('var(--site-accent-text)');
    expect(light['blue-text']).toBe('var(--site-accent)');
  });

  // The signed-in app's own tokens (theme.css): a button's label on its fill, blue text and
  // links, and the muted and faint labels, on the surfaces they sit on.
  it.each([
    ['light', block(':root {', themeCss)],
    ['dark', block(':root[data-theme="dark"] {', themeCss)],
  ])('keeps the app %s palette at AA', (_theme, t) => {
    const pairs: [string, string][] = [
      ['on-accent', 'blue'],
      ['blue-text', 'bg'],
      ['blue-text', 'surface'],
      ['blue-text', 'surface-2'],
      ['blue-text', 'accent-soft'],
      ['text', 'bg'],
      ['text', 'surface'],
      ['muted', 'bg'],
      ['muted', 'surface'],
      ['muted', 'surface-2'],
      ['faint', 'bg'],
      ['faint', 'surface'],
      ['faint', 'surface-2'],
      ['success', 'success-soft'],
      ['success', 'surface'],
      ['danger', 'surface'],
      ['warn', 'surface'],
    ];
    for (const [fg, bg] of pairs)
      expect(`${fg} on ${bg}: ${contrast(t[fg], t[bg]) >= 4.5}`).toBe(`${fg} on ${bg}: true`);
  });

  it('defines the same app dark palette for the system choice and the explicit choice', () => {
    expect(block(':root:not([data-theme="light"]) {', themeCss)).toEqual(
      block(':root[data-theme="dark"] {', themeCss),
    );
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps every %s text pair at AA', (_theme, t) => {
    const pairs: [string, string][] = [
      ['site-accent-text', 'site-accent'],
      ['site-text', 'site-bg'],
      ['site-text', 'site-surface'],
      ['site-muted', 'site-bg'],
      ['site-muted', 'site-surface'],
      ['site-muted', 'site-accent-soft'],
      ['site-faint', 'site-bg'],
      ['site-faint', 'site-surface'],
      ['site-good', 'site-surface'],
      ['site-warn', 'site-surface'],
      ['site-code-text', 'site-code-bg'],
    ];
    for (const [fg, bg] of pairs)
      expect(`${fg} on ${bg}: ${contrast(t[fg], t[bg]) >= 4.5}`).toBe(`${fg} on ${bg}: true`);
  });

  it('defines the same dark palette for the system choice and the explicit choice', () => {
    expect(block(':root:not([data-theme="light"]) .site {')).toEqual(dark);
  });
});
