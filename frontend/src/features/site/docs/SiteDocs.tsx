// The docs (`/docs/...`): a docs header (tabs and search) under the site header, the tab's
// sidebar on the left (a drawer behind "Menu" at phone width), the page in the middle (group,
// title, summary, Copy page, body, previous and next) and "On this page" on the right.
import { ArrowLeft, ArrowRight, Check, Copy, Menu, X } from 'lucide-react';
import { type MouseEvent, useEffect, useMemo, useState } from 'react';
import type { Navigate } from '../../shell/useRoute';
import type { LinkResolver } from '../../source-platform/markdown';
import { inline } from '../../source-platform/markdown';
import { siteLink } from '../SiteLayout';
import { contentLinks } from '../SitePages';
import { DOCS_HOME, formatSitePage } from '../siteRoute';
import { DocsBody, useCopy } from './DocsBody';
import { DocsSearch } from './DocsSearch';
import { DocsSidebar } from './DocsSidebar';
import { DocsToc } from './DocsToc';
import { DOCS_PAGES, pageMarkdown } from './docsContent';
import { tocOf } from './docsHeadings';
import { DOCS_TABS, locate, neighbors } from './docsNav';

const scrollToHash = (hash: string) =>
  requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());

/** Opens a docs page, at one of its sections when `hash` is given. */
function openDoc(navigate: Navigate, slug: string, hash?: string) {
  navigate({ view: 'site', site: { page: 'docs', slug } });
  if (!hash) return;
  window.history.replaceState(null, '', `${formatSitePage({ page: 'docs', slug })}#${hash}`);
  scrollToHash(hash);
}

/** Content links: `/docs/x#y` opens the page at that section; other paths as on the site. */
const docsLinks =
  (navigate: Navigate): LinkResolver =>
  (path) => {
    const match = /^\/docs(?:\/([a-z0-9/-]*))?(?:#(.+))?$/.exec(path);
    if (!match) return contentLinks(navigate)(path);
    const slug = match[1]?.replace(/\/$/, '') || DOCS_HOME;
    const hash = match[2];
    const base = formatSitePage({ page: 'docs', slug });
    return {
      href: hash ? `${base}#${hash}` : base,
      onClick: (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        openDoc(navigate, slug, hash);
      },
    };
  };

function CopyPage({ markdown }: { markdown: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" className="docs-copy-page" onClick={() => copy(markdown)}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy page'}
    </button>
  );
}

function Pager({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const { prev, next } = neighbors(slug);
  if (!prev && !next) return null;
  return (
    <nav className="docs-pager" aria-label="Previous and next pages">
      {prev ? (
        <a className="docs-pager-link" {...siteLink({ page: 'docs', slug: prev }, navigate)}>
          <span>
            <ArrowLeft size={14} aria-hidden="true" /> Previous
          </span>
          {DOCS_PAGES[prev]?.title}
        </a>
      ) : (
        <span />
      )}
      {next && (
        <a
          className="docs-pager-link docs-pager-next"
          {...siteLink({ page: 'docs', slug: next }, navigate)}
        >
          <span>
            Next <ArrowRight size={14} aria-hidden="true" />
          </span>
          {DOCS_PAGES[next]?.title}
        </a>
      )}
    </nav>
  );
}

export function SiteDocs({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const page = DOCS_PAGES[slug];
  const place = locate(slug);
  const tab = place?.tab ?? DOCS_TABS[0];
  const [drawer, setDrawer] = useState(false);
  const headings = useMemo(() => (page ? tocOf(page.body) : []), [page]);
  // Following a link closes the phone drawer.
  const go: Navigate = (next, options) => {
    setDrawer(false);
    navigate(next, options);
  };
  const link = docsLinks(go);

  useEffect(() => {
    document.title = `${page?.title ?? 'Page not found'} — YonedaRepo Docs`;
  }, [page]);
  // A page opened at an address with a section (`/docs/x#y`) scrolls to it once drawn.
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) scrollToHash(hash);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="docs">
      <div className="docs-header">
        <button
          type="button"
          className="docs-menu-button"
          aria-expanded={drawer}
          aria-controls="docs-drawer"
          onClick={() => setDrawer(!drawer)}
        >
          {drawer ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
          Menu
        </button>
        <nav className="docs-tabs" aria-label="Docs sections">
          <ul>
            {DOCS_TABS.map((t) => (
              <li key={t.id}>
                <a
                  className="docs-tab"
                  {...siteLink({ page: 'docs', slug: t.groups[0].entries[0].slug }, go)}
                  aria-current={t.id === tab.id ? 'page' : undefined}
                >
                  {t.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <DocsSearch onOpen={(hit) => openDoc(go, hit.slug, hit.anchor || undefined)} />
      </div>
      <div className="docs-columns">
        <div id="docs-drawer" className={drawer ? 'docs-drawer open' : 'docs-drawer'}>
          <DocsSidebar tab={tab} current={slug} navigate={go} />
        </div>
        {drawer && (
          <button
            type="button"
            className="docs-drawer-backdrop"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          />
        )}
        <article className="docs-main">
          {page ? (
            <>
              {place && <p className="docs-eyebrow">{place.group.title}</p>}
              <div className="docs-title">
                <h1>{page.title}</h1>
                <CopyPage markdown={pageMarkdown(page)} />
              </div>
              {page.summary && <p className="docs-summary">{inline(page.summary, 's')}</p>}
              <div className="docs-prose">
                <DocsBody body={page.body} link={link} />
              </div>
              <Pager slug={slug} navigate={go} />
            </>
          ) : (
            <>
              <h1>Page not found</h1>
              <p>
                There is no docs page at this address.{' '}
                <a {...siteLink({ page: 'docs', slug: DOCS_HOME }, go)}>Start here</a>.
              </p>
            </>
          )}
        </article>
        <DocsToc headings={headings} />
      </div>
    </div>
  );
}
