// The public site's frame: top nav (sections, then Sign in / Get started, or Open app when
// signed in), the page, and a footer. At phone width the sections fold into a menu button.
import { GitBranch, Menu, Monitor, Moon, Sun, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { navSection, SITE_NAV, type SitePage } from './siteRoute';
import { nextTheme, readTheme, type Theme, writeTheme } from './theme';

const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

export const siteLink = (page: SitePage, navigate: Navigate) =>
  linkTo({ view: 'site', site: page }, navigate);

export function SiteLayout({
  page,
  authenticated,
  navigate,
  children,
}: {
  page: SitePage;
  authenticated: boolean;
  navigate: Navigate;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const ThemeIcon = THEME_ICON[theme];
  const current = navSection(page);
  // Following a link closes the phone menu.
  const go: Navigate = (next, options) => {
    setOpen(false);
    navigate(next, options);
  };
  return (
    <div className="site">
      <a className="skip-link" href="#site-main">
        Skip to content
      </a>
      <header className="site-header">
        <nav className="site-nav" aria-label="Main">
          <a className="site-brand" {...siteLink({ page: 'home' }, go)}>
            <GitBranch size={20} aria-hidden="true" />
            YonedaRepo
          </a>
          <button
            type="button"
            className="site-theme"
            aria-label={`Theme: ${THEME_LABEL[theme]} (switch to ${THEME_LABEL[nextTheme(theme)]})`}
            title={`Theme: ${THEME_LABEL[theme]}`}
            onClick={() => {
              const next = nextTheme(theme);
              writeTheme(next);
              setTheme(next);
            }}
          >
            <ThemeIcon size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="site-menu-button"
            aria-expanded={open}
            aria-controls="site-sections"
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
            Menu
          </button>
          <div id="site-sections" className={open ? 'site-sections open' : 'site-sections'}>
            <ul>
              {SITE_NAV.map((item) => (
                <li key={item.label}>
                  <a
                    className="site-nav-link"
                    {...siteLink(item.page, go)}
                    aria-current={current === item.label ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="site-account">
              {authenticated ? (
                <a className="site-button" {...linkTo({ view: 'home' }, go)}>
                  Open app
                </a>
              ) : (
                <>
                  <a
                    className="site-quiet-link"
                    {...siteLink({ page: 'signin', mode: 'login' }, go)}
                  >
                    Sign in
                  </a>
                  <a className="site-button" {...siteLink({ page: 'signin', mode: 'signup' }, go)}>
                    Get started
                  </a>
                </>
              )}
            </div>
          </div>
        </nav>
      </header>
      <main id="site-main" className="site-main">
        {children}
      </main>
      <footer className="site-footer">
        <nav aria-label="Footer">
          <ul>
            {SITE_NAV.map((item) => (
              <li key={item.label}>
                <a {...siteLink(item.page, go)}>{item.label}</a>
              </li>
            ))}
            <li>
              <a {...siteLink({ page: 'vision' }, go)}>Vision</a>
            </li>
            <li>
              <a {...linkTo({ view: 'explore' }, go)}>Explore public repositories</a>
            </li>
            <li>
              <a {...siteLink({ page: 'legal', doc: 'terms' }, go)}>Terms</a>
            </li>
            <li>
              <a {...siteLink({ page: 'legal', doc: 'privacy' }, go)}>Privacy</a>
            </li>
          </ul>
        </nav>
        <p>
          © {new Date().getFullYear()} Yoneda Labs. YonedaRepo is a Git-compatible source platform.
        </p>
      </footer>
    </div>
  );
}
