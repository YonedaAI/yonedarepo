// The docs' left sidebar: outside links (GitHub, Discord, Blog), then the current tab's
// groups. A page with sub-pages folds them under a chevron, open while one of them is shown.
import { ChevronRight, MessageCircle, Newspaper } from 'lucide-react';
import { useState } from 'react';
import type { Navigate } from '../../shell/useRoute';
import { SOCIAL_LINKS } from '../SiteFooter';
import { siteLink } from '../SiteLayout';
import { DOCS_PAGES } from './docsContent';
import type { DocsEntry, DocsTab } from './docsNav';

// GitHub's mark (lucide carries no brand marks), in the text's color.
const GithubMark = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
    />
  </svg>
);

const socialUrl = (label: string) => SOCIAL_LINKS.find((link) => link.label === label)?.url;

function PageLink({
  slug,
  current,
  navigate,
}: {
  slug: string;
  current: string;
  navigate: Navigate;
}) {
  return (
    <a
      className="docs-nav-link"
      {...siteLink({ page: 'docs', slug }, navigate)}
      aria-current={slug === current ? 'page' : undefined}
    >
      {DOCS_PAGES[slug]?.title ?? slug}
    </a>
  );
}

function Entry({
  entry,
  current,
  navigate,
}: {
  entry: DocsEntry;
  current: string;
  navigate: Navigate;
}) {
  const holdsCurrent = entry.slug === current || !!entry.children?.includes(current);
  const [open, setOpen] = useState(holdsCurrent);
  if (!entry.children?.length)
    return (
      <li>
        <PageLink slug={entry.slug} current={current} navigate={navigate} />
      </li>
    );
  const id = `docs-sub-${entry.slug.replace(/\//g, '-')}`;
  return (
    <li>
      <div className="docs-nav-parent">
        <PageLink slug={entry.slug} current={current} navigate={navigate} />
        <button
          type="button"
          className="docs-nav-toggle"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`${open ? 'Hide' : 'Show'} pages under ${DOCS_PAGES[entry.slug]?.title ?? entry.slug}`}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <ul id={id} className="docs-nav-children" hidden={!open}>
        {entry.children.map((slug) => (
          <li key={slug}>
            <PageLink slug={slug} current={current} navigate={navigate} />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function DocsSidebar({
  tab,
  current,
  navigate,
}: {
  tab: DocsTab;
  current: string;
  navigate: Navigate;
}) {
  const github = socialUrl('GitHub');
  const discord = socialUrl('Discord');
  return (
    <nav className="docs-sidebar" aria-label={`${tab.label} pages`}>
      <ul className="docs-nav-top">
        {github && (
          <li>
            <a className="docs-nav-out" href={github} target="_blank" rel="noreferrer noopener">
              <GithubMark />
              GitHub
            </a>
          </li>
        )}
        {discord && (
          <li>
            <a className="docs-nav-out" href={discord} target="_blank" rel="noreferrer noopener">
              <MessageCircle size={16} aria-hidden="true" />
              Discord
            </a>
          </li>
        )}
        <li>
          <a className="docs-nav-out" {...siteLink({ page: 'blog' }, navigate)}>
            <Newspaper size={16} aria-hidden="true" />
            Blog
          </a>
        </li>
      </ul>
      {tab.groups.map((group) => {
        const id = `docs-group-${tab.id}-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        return (
          <div key={group.title} className="docs-nav-group">
            <p className="docs-nav-heading" id={id}>
              {group.title}
            </p>
            <ul aria-labelledby={id}>
              {group.entries.map((entry) => (
                <Entry key={entry.slug} entry={entry} current={current} navigate={navigate} />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
