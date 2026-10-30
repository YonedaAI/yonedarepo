// The public site's footer: four link columns, a small faint wordmark, and a bottom row with a
// live status (the front's own /health, fetched on mount: a dot and a word) and the copyright.
import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LEGAL_ENTITY } from '../../content/legal/entity';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { SourceRoute } from '../source-platform/sourceRoute';
import { featurePageFor } from './featurePages';
import { EVENTS_URL, sectionLink } from './siteLinks';
import { DOCS_HOME } from './siteRoute';

/** A footer link: an app route, optionally to an anchor on it, or an outside address. */
export type FooterLink = { label: string } & (
  | { route: SourceRoute; hash?: string }
  | { href: string }
);

/** The Connect column, in order; an entry renders only while its URL is set. */
export const SOCIAL_LINKS: { label: string; url: string }[] = [
  { label: 'GitHub', url: 'https://github.com/YonedaRepo' },
  { label: 'X', url: 'https://x.com/YonedaRepo' },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/company/yonedarepo' },
  { label: 'YouTube', url: 'https://www.youtube.com/@YonedaRepo' },
  { label: 'Discord', url: 'https://discord.gg/yonedarepo' },
  { label: 'Email us', url: 'mailto:hello@yonedarepo.com' },
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
      { label: 'Code as Transactions', route: site(featurePageFor('transactions')) },
      { label: 'Review agents', route: site(featurePageFor('review-agents')) },
      { label: 'CLI', route: site({ page: 'docs', slug: 'guides/cli' }) },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Blog', route: site({ page: 'blog' }) },
      { label: 'About', route: site({ page: 'about' }) },
      { label: 'Vision', route: site({ page: 'vision' }) },
      { label: 'Events', href: EVENTS_URL },
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
    links: SOCIAL_LINKS.filter((s) => s.url).map((s) => ({ label: s.label, href: s.url })),
  },
];

/** The anchor's props: in-app routes navigate without a reload, then scroll to the hash. */
function anchor(link: FooterLink, navigate: Navigate) {
  // Outside pages open in a new tab; an email link opens the mail app, so it needs no tab.
  if ('href' in link)
    return link.href.startsWith('mailto:')
      ? { href: link.href }
      : { href: link.href, target: '_blank', rel: 'noopener noreferrer' };
  return link.hash ? sectionLink(link.route, link.hash, navigate) : linkTo(link.route, navigate);
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

/** The status: nothing while the check runs, then a green or amber dot with its word. */
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
