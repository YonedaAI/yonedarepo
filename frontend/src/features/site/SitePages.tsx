// The site's written pages: Docs (`/docs/...`, left navigation), Blog (index and posts),
// Company (About, Vision) and the Terms and Privacy pages, each from its Markdown file.

import { LEGAL_ENTITY } from '../../content/legal/entity';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { LinkResolver } from '../source-platform/markdown';
import { anchorId, inline, Markdown } from '../source-platform/markdown';
import { parseSourceRoute } from '../source-platform/sourceRoute';
import { BLOG_POSTS, COMPANY_PAGES, DOCS_NAV, DOCS_PAGES, LEGAL_PAGES } from './content';
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

const longDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** The blog index, or one post when `slug` is given. */
export function SiteBlog({ slug, navigate }: { slug?: string; navigate: Navigate }) {
  if (slug === undefined)
    return (
      <article className="site-page">
        <header className="site-page-head">
          <h1>Blog</h1>
          <p className="site-lead">Notes from building YonedaRepo, with the numbers we measured.</p>
        </header>
        <ul className="site-posts">
          {BLOG_POSTS.map((post) => (
            <li key={post.slug}>
              <time dateTime={post.date}>{longDate(post.date)}</time>
              <h2>
                <a {...siteLink({ page: 'post', slug: post.slug }, navigate)}>{post.title}</a>
              </h2>
              <p>{inline(post.summary, post.slug)}</p>
            </li>
          ))}
        </ul>
      </article>
    );
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  return (
    <article className="site-prose site-post">
      <p>
        <a {...siteLink({ page: 'blog' }, navigate)}>← Blog</a>
      </p>
      {post ? (
        <>
          <h1>{post.title}</h1>
          <p className="site-byline">
            <time dateTime={post.date}>{longDate(post.date)}</time> · Yoneda Labs
          </p>
          <Markdown source={post.body} shift={0} link={contentLinks(navigate)} anchors />
        </>
      ) : (
        <>
          <h1>Post not found</h1>
          <p>There is no post at this address.</p>
        </>
      )}
    </article>
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
