// The docs: routing, the navigation and its reading order, the search index, the "On this
// page" headings, the docs Markdown extras, and every internal link in every page.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MARGIN,
  CONTAINER_USD_PER_MINUTE,
  MANAGED_AGENTS,
  STARTING_CREDIT_USD,
} from '../../../../../shared/managed-agents';
import { parseSourceRoute } from '../../source-platform/sourceRoute';
import { DOCS_HOME, formatSitePage } from '../siteRoute';
import { DocsBody } from './DocsBody';
import { DOCS_PAGES, pageLinks, pageMarkdown, parseCards, plainText } from './docsContent';
import { pageHeadings, tocOf } from './docsHeadings';
import { pageEntries, SEARCH_INDEX, searchDocs } from './docsIndex';
import { DOCS_ORDER, DOCS_TABS, locate, neighbors } from './docsNav';
import { SiteDocs } from './SiteDocs';

const navigate = () => {};
const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const page = (body: string, title = 'T') => ({ slug: 'x', title, summary: 'S', body });

describe('docs routing', () => {
  it('opens the introduction at /docs and any page by its slug', () => {
    expect(DOCS_HOME).toBe('introduction');
    expect(parseSourceRoute('/docs', '')).toEqual({
      view: 'site',
      site: { page: 'docs', slug: 'introduction' },
    });
    expect(parseSourceRoute('/docs/agents/review-agents', '')).toEqual({
      view: 'site',
      site: { page: 'docs', slug: 'agents/review-agents' },
    });
  });

  it('marks the tab, the group and the page of the one shown', () => {
    const html = render(createElement(SiteDocs, { slug: 'guides/lfs', navigate }));
    expect(html).toMatch(/class="docs-tab"[^>]*aria-current="page"[^>]*>Documentation</);
    expect(html).toContain('<p class="docs-eyebrow">Git</p>');
    expect(html).toMatch(/href="\/docs\/guides\/lfs" aria-current="page"/);
    // Its parent's sub-pages are open; another parent's stay folded.
    expect(html).toMatch(/id="docs-sub-guides-git-remotes" class="docs-nav-children">/);
    expect(html).toMatch(/id="docs-sub-guides-changes" class="docs-nav-children" hidden/);
  });

  it('shows another tab’s sidebar for a page in it', () => {
    const html = render(createElement(SiteDocs, { slug: 'reference/cli', navigate }));
    expect(html).toMatch(/aria-current="page"[^>]*>CLI Reference</);
    expect(html).toContain('aria-label="CLI Reference pages"');
    expect(html).not.toContain('href="/docs/guides/lfs"');
  });
});

describe('docs navigation', () => {
  it('lists each page once, in a tab, with a title and a summary', () => {
    expect(DOCS_TABS.map((t) => t.label)).toEqual([
      'Documentation',
      'Agents',
      'CLI Reference',
      'API',
    ]);
    for (const slug of DOCS_ORDER) {
      expect(DOCS_PAGES[slug]?.title, slug).toBeTruthy();
      expect(DOCS_PAGES[slug]?.summary, slug).toBeTruthy();
      expect(locate(slug), slug).toBeDefined();
    }
  });

  it('links every sidebar entry to a page that renders', () => {
    for (const tab of DOCS_TABS) {
      const html = render(
        createElement(SiteDocs, { slug: tab.groups[0].entries[0].slug, navigate }),
      );
      for (const group of tab.groups)
        for (const entry of group.entries)
          for (const slug of [entry.slug, ...(entry.children ?? [])])
            expect(html, slug).toContain(`href="${formatSitePage({ page: 'docs', slug })}"`);
    }
  });

  it('reads in order: previous and next follow the sidebar', () => {
    expect(neighbors(DOCS_ORDER[0])).toEqual({ prev: undefined, next: DOCS_ORDER[1] });
    expect(neighbors('guides/git-remotes')).toEqual({
      prev: 'accounts',
      next: 'guides/yoneda-remotes',
    });
    expect(neighbors('nope')).toEqual({});
  });
});

describe('docs links', () => {
  // Pages a link may reach outside the docs: a site page or an app route.
  const resolves = (path: string) => {
    const [pathname, hash] = path.split('#');
    const route = parseSourceRoute(pathname, '');
    if (route.view !== 'site') return route.view !== 'home' || pathname === '/';
    if (route.site.page !== 'docs') return true;
    const target = DOCS_PAGES[route.site.slug];
    return !!target && (!hash || pageHeadings(target.body).some((h) => h.id === hash));
  };

  it.each(DOCS_ORDER)('has no dead internal link on %s', (slug) => {
    const links = pageLinks(DOCS_PAGES[slug]);
    for (const link of links) expect(`${link}: ${resolves(link)}`).toBe(`${link}: true`);
  });

  it('notices a dead link, a missing section and a link inside code', () => {
    expect(resolves('/docs/guides/nope')).toBe(false);
    expect(resolves('/docs/guides/sessions#nope')).toBe(false);
    expect(resolves('/docs/guides/sessions#declared-reads')).toBe(true);
    expect(pageLinks(page('[a](/docs/a)\n\n```text\n[b](/docs/b)\n```'))).toEqual(['/docs/a']);
  });
});

describe('docs search', () => {
  it('indexes each page’s opening and its sections', () => {
    const entries = pageEntries(page('Intro words\n\n## Retry budget\n\nThe `budget` is shared.'));
    expect(entries).toEqual([
      { slug: 'x', page: 'T', heading: '', anchor: '', text: 'S Intro words' },
      {
        slug: 'x',
        page: 'T',
        heading: 'Retry budget',
        anchor: 'retry-budget',
        text: 'The budget is shared.',
      },
    ]);
    expect(SEARCH_INDEX.length).toBeGreaterThan(DOCS_ORDER.length);
  });

  it('needs every word, and ranks title over heading over text', () => {
    const index = [
      ...pageEntries(page('## Other\n\nlfs in the text', 'Tokens')),
      ...pageEntries(page('## LFS quota\n\nquota words', 'Repositories')),
      ...pageEntries(page('Large files', 'Git LFS')),
    ];
    const hits = searchDocs('lfs', 10, index);
    expect(hits.map((h) => `${h.page}/${h.heading}`)).toEqual([
      'Git LFS/',
      'Repositories/LFS quota',
      'Tokens/Other',
    ]);
    expect(searchDocs('lfs quota', 10, index).map((h) => h.heading)).toEqual(['LFS quota']);
    expect(searchDocs('   ', 10, index)).toEqual([]);
    expect(searchDocs('nothing-like-this', 10, index)).toEqual([]);
  });

  it('finds real pages by title, heading and body text', () => {
    expect(searchDocs('webhooks')[0].slug).toBe('guides/webhooks');
    expect(searchDocs('cloudflared').some((h) => h.slug === 'guides/git-remotes')).toBe(true);
    const hit = searchDocs('verify the signature')[0];
    expect([hit.slug, hit.anchor]).toEqual(['guides/webhooks', 'verify-the-signature']);
    expect(hit.snippet.length).toBeLessThan(160);
  });
});

describe('docs headings and table of contents', () => {
  it('gives repeated headings unique ids and lists only H2 and H3', () => {
    const body =
      '## Git\n\n### `clone` *now*\n\n## Git\n\n#### Deep\n\n```sh\n## not a heading\n```';
    expect(pageHeadings(body).map((h) => h.id)).toEqual(['git', 'clone-now', 'git-2', 'deep']);
    expect(tocOf(body).map((h) => [h.level, h.id])).toEqual([
      [2, 'git'],
      [3, 'clone-now'],
      [2, 'git-2'],
    ]);
  });

  it('renders the same ids the table of contents links to', () => {
    const body = DOCS_PAGES['reference/cli'].body;
    const html = render(createElement(DocsBody, { body, link: () => undefined }));
    for (const h of pageHeadings(body)) expect(html).toContain(`id="${h.id}"`);
    const page = render(createElement(SiteDocs, { slug: 'reference/cli', navigate }));
    for (const h of tocOf(body)) expect(page).toContain(`href="#${h.id}"`);
  });
});

describe('docs Markdown extras', () => {
  it('draws cards, callouts and labelled code with a copy button', () => {
    const body = [
      '```cards',
      'git | Push | With *stock* Git. | /docs/get-started',
      'broken line',
      '```',
      '',
      '> [!WARNING] Save the **code**.',
      '',
      '> [!NOTE] Plain note.',
      '',
      '```sh',
      'git push',
      '```',
    ].join('\n');
    const html = render(createElement(DocsBody, { body, link: () => undefined }));
    expect(html.match(/class="docs-card"/g)).toHaveLength(1);
    expect(html).toContain('href="/docs/get-started"');
    expect(html).toContain('docs-callout-warning');
    expect(html).toContain('<strong>Warning</strong>');
    expect(html).toContain('docs-callout-note');
    expect(html).toContain('<span>Shell</span>');
    expect(html).toContain('aria-label="Copy code"');
  });

  it('copies a page as plain Markdown, cards as a link list', () => {
    const md = pageMarkdown(page('```cards\nkey | Tokens | Make one. | /docs/guides/tokens\n```'));
    expect(md).toBe('# T\n\nS\n\n- [Tokens](/docs/guides/tokens): Make one.\n');
    expect(parseCards('a | b | c\nx | y | z | /w')).toEqual([
      { icon: 'x', title: 'y', text: 'z', href: '/w' },
    ]);
    expect(plainText('**Bold** `code` [link](/x) and _em_')).toBe('Bold code link and em');
  });

  it('gives the docs home the cards it promises', () => {
    const cards = parseCards(
      /```cards\n([\s\S]*?)\n```/.exec(DOCS_PAGES.introduction.body)?.[1] ?? '',
    );
    expect(cards.map((c) => c.title)).toEqual([
      'Create an account',
      'Push with stock Git',
      'Install the CLI',
      'Connect an agent',
      'Turn on review agents',
    ]);
  });
});

// The review agents' pages quote the shared contract's numbers; they must stay in step.
describe('review agent claims', () => {
  const credit = DOCS_PAGES['agents/review-credit'].body;
  const agents = DOCS_PAGES['agents/review-agents'].body;

  it('quotes the starting credit, margin, container price and per-run caps', () => {
    expect(credit).toContain(`$${STARTING_CREDIT_USD} of credit`);
    expect(credit).toContain(`plus ${Math.round((AGENT_MARGIN - 1) * 100)}%`);
    expect(credit).toContain(`$${CONTAINER_USD_PER_MINUTE} a minute`);
    for (const agent of MANAGED_AGENTS) {
      const cap =
        agent.cost_cap_usd < 1 ? agent.cost_cap_usd.toFixed(2) : String(agent.cost_cap_usd);
      expect(credit).toContain(`$${cap} for ${agent.defaults.name}`);
    }
  });

  it('names each agent with its default model and check', () => {
    for (const agent of MANAGED_AGENTS) {
      expect(agents).toContain(`**${agent.defaults.name}**`);
      expect(agents).toContain(`\`${agent.defaults.model}\``);
      expect(agents).toContain(`\`${agent.check}\``);
    }
  });
});
