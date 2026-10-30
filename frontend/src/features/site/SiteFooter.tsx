// The public site's footer: four link columns, a faint wordmark, and a bottom row with a live
// status pill (the front's own /health, fetched on mount) and the copyright line.
import { GitBranch } from 'lucide-react';
import { type MouseEvent, useEffect, useState } from 'react';
import { LEGAL_ENTITY } from '../../content/legal/entity';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { SourceRoute } from '../source-platform/sourceRoute';
import { DOCS_HOME } from './siteRoute';

/** A footer link: an app route, optionally to an anchor on it, or an outside address. */
export type FooterLink = { label: string } & (
  | { route: SourceRoute; hash?: string }
  | { href: string }
);

/** Public profiles; an entry renders only once its URL is set. */
export const SOCIAL_LINKS: { label: string; url: string }[] = [
  { label: 'X', url: '' },
  { label: 'LinkedIn', url: '' },
  { label: 'GitHub', url: '' },
  { label: 'Discord', url: '' },
];

const site = (page: Extract<SourceRoute, { view: 'site' }>['site']): SourceRoute => ({
  view: 'site',
  site: page,
});

export const FOOTER_COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', route: site({ page: 'features' }) },
      { label: 'Pricing', route: site({ page: 'pricing' }) },
      { label: 'Docs', route: site({ page: 'docs', slug: DOCS_HOME }) },
      { label: 'Code as Transactions', route: site({ page: 'features' }), hash: 'landing' },
      { label: 'Review agents', route: { view: 'home' }, hash: 'build-review-agents' },
      { label: 'CLI', route: site({ page: 'docs', slug: 'guides/cli' }) },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Blog', route: site({ page: 'blog' }) },
      { label: 'About', route: site({ page: 'about' }) },
      { label: 'Vision', route: site({ page: 'vision' }) },
      { label: 'Explore public repositories', route: { view: 'explore' } },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', route: site({ page: 'legal', doc: 'privacy' }) },
      { label: 'Terms of Service', route: site({ page: 'legal', doc: 'terms' }) },
      { label: 'Cookies', route: site({ page: 'legal', doc: 'privacy' }), hash: 'cookies' },
    ],
  },
  {
    title: 'Connect',
    links: [
      { label: 'Email us', href: 'mailto:hello@yonedarepo.com' },
      ...SOCIAL_LINKS.filter((s) => s.url).map((s) => ({ label: s.label, href: s.url })),
    ],
  },
];

/** The anchor's props: in-app routes navigate without a reload, then scroll to the hash. */
function anchor(link: FooterLink, navigate: Navigate) {
  if ('href' in link) return { href: link.href };
  const base = linkTo(link.route, navigate);
  if (!link.hash) return base;
  const href = `${base.href}#${link.hash}`;
  return {
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(link.route);
      window.history.replaceState(null, '', href);
      // The page renders on the next frame; then its section can be found.
      requestAnimationFrame(() => document.getElementById(link.hash ?? '')?.scrollIntoView());
    },
  };
}

export type Health = 'operational' | 'degraded';

/** The front's /health within `timeoutMs`: answering as YonedaRepo is operational; an error,
 * another answer or a slow one is degraded. */
export async function checkHealth(
  fetcher: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<Health> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher('/health', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return 'degraded';
    const body = (await response.json()) as { service?: string };
    return body.service === 'yonedarepo' ? 'operational' : 'degraded';
  } catch {
    return 'degraded';
  } finally {
    clearTimeout(timer);
  }
}

/** The pill: nothing while the check runs, then a green or amber dot with its word. */
export function StatusPill({ health }: { health: Health | null }) {
  if (!health) return null;
  return (
    <p className={`site-status site-status-${health}`} role="status">
      <span className="site-status-dot" aria-hidden="true" />
      {health === 'operational' ? 'Operational' : 'Degraded'}
    </p>
  );
}

export function SiteFooter({ navigate }: { navigate: Navigate }) {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let live = true;
    void checkHealth().then((h) => live && setHealth(h));
    return () => {
      live = false;
    };
  }, []);
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-top">
          <nav className="site-footer-columns" aria-label="Footer">
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.title}>
                <p className="site-footer-heading" id={`footer-${column.title.toLowerCase()}`}>
                  {column.title}
                </p>
                <ul aria-labelledby={`footer-${column.title.toLowerCase()}`}>
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a {...anchor(link, navigate)}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <span className="site-footer-mark" aria-hidden="true">
            <GitBranch /> YonedaRepo
          </span>
        </div>
        <div className="site-footer-bottom">
          <StatusPill health={health} />
          <p>
            © {new Date().getFullYear()} {LEGAL_ENTITY.legalName}
          </p>
        </div>
      </div>
    </footer>
  );
}
