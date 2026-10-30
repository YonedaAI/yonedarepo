// The site's written pages: Docs (`/docs/...`, left navigation), Company (About, Vision)
// and the Terms and Privacy pages, each from its Markdown file. The blog is `SiteBlog`.

import { LEGAL_ENTITY } from '../../content/legal/entity';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { LinkResolver } from '../source-platform/markdown';
import { anchorId, inline, Markdown } from '../source-platform/markdown';
import { parseSourceRoute } from '../source-platform/sourceRoute';
import { COMPANY_PAGES, DOCS_NAV, DOCS_PAGES, LEGAL_PAGES } from './content';
import { siteLink } from './SiteLayout';
import { DOCS_HOME } from './siteRoute';

/** Same-site links in content (`/docs/guides/cli`, `/pricing`) navigate in place. */
export const contentLinks =
  (navigate: Navigate): LinkResolver =>
  (path) => {
    const [pathname, hash] = path.split('#');
    const { href, onClick } = linkTo(parseSourceRoute(pathname, ''), navigate);
    return { href: hash ? `${href}#${hash}` : href, onClick };
  };

export function SiteDocs({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const page = DOCS_PAGES[slug];
  return (
    <div className="site-docs">
      <nav className="site-docs-nav" aria-label="Docs">
        {DOCS_NAV.map((section) => (
          <div key={section.section}>
            <p className="site-docs-section" id={`docs-${section.pages[0].replace('/', '-')}`}>
              {section.section}
            </p>
            <ul aria-labelledby={`docs-${section.pages[0].replace('/', '-')}`}>
              {section.pages.map((s) => (
                <li key={s}>
                  <a
                    className="site-docs-link"
                    {...siteLink({ page: 'docs', slug: s }, navigate)}
                    aria-current={s === slug ? 'page' : undefined}
                  >
                    {DOCS_PAGES[s]?.title ?? s}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <article className="site-prose">
        {page ? (
          <>
            <h1>{page.title}</h1>
            {page.summary && <p className="site-lead">{inline(page.summary, 's')}</p>}
            <Markdown source={page.body} shift={0} link={contentLinks(navigate)} anchors />
          </>
        ) : (
          <>
            <h1>Page not found</h1>
            <p>
              There is no docs page at this address.{' '}
              <a {...siteLink({ page: 'docs', slug: DOCS_HOME }, navigate)}>Start here</a>.
            </p>
          </>
        )}
      </article>
    </div>
  );
}

export function SiteCompany({ page, navigate }: { page: 'about' | 'vision'; navigate: Navigate }) {
  const content = COMPANY_PAGES[page];
  return (
    <div className="site-company">
      <nav aria-label="Company">
        <ul className="site-tabs">
          {(['about', 'vision'] as const).map((p) => (
            <li key={p}>
              <a
                className="site-tab"
                {...siteLink({ page: p }, navigate)}
                aria-current={p === page ? 'page' : undefined}
              >
                {p === 'about' ? 'About' : 'Vision'}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <article className="site-prose">
        <h1>{content.title}</h1>
        {content.summary && <p className="site-lead">{inline(content.summary, 's')}</p>}
        <Markdown source={content.body} shift={0} link={contentLinks(navigate)} anchors />
      </article>
    </div>
  );
}

/** Terms (`/terms`) or Privacy (`/privacy`), with its status (a draft notice) above it. */
export function SiteLegal({ doc, navigate }: { doc: 'terms' | 'privacy'; navigate: Navigate }) {
  const content = LEGAL_PAGES[doc];
  // The contents list: the page's sections, its `## ` headings, in order.
  const sections = [...content.body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  return (
    <article className="site-prose site-post">
      {content.status && (
        <p className="site-notice" role="note">
          {content.status}
        </p>
      )}
      <h1>{content.title}</h1>
      {content.summary && <p className="site-lead">{inline(content.summary, 's')}</p>}
      <p className="site-updated">
        Last updated <time dateTime={LEGAL_ENTITY.lastUpdated}>{LEGAL_ENTITY.lastUpdated}</time>
      </p>
      <nav className="site-contents" aria-label="Contents">
        <h2>Contents</h2>
        <ol>
          {sections.map((title) => (
            <li key={title}>
              <a href={`#${anchorId(title)}`}>{title}</a>
            </li>
          ))}
        </ol>
      </nav>
      <Markdown source={content.body} shift={0} link={contentLinks(navigate)} anchors />
    </article>
  );
}
