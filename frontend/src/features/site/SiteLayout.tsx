// The public site's frame: the header (logo; the sections centred, with Features and Company
// menus; then Sign in / Get started, or Open app when signed in), the page, and a footer. At
// phone width the sections fold into a menu button.
// The site's faces, self-hosted from their npm packages (latin only): Inter for text,
// Inter Tight for headings.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter-tight/latin-600.css';
import { GitBranch, Menu, Monitor, Moon, Sun, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { nextTheme, type Theme, useTheme } from '../shell/theme';
import { linkTo, type Navigate } from '../shell/useRoute';
import { SiteFooter } from './SiteFooter';
import { SiteNavMenus } from './SiteNavMenus';
import { sectionLink, siteLink } from './siteLinks';
import { navSection, type SitePage } from './siteRoute';

const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

// The link helpers live in siteLinks.ts; pages import them from here as before.
export { sectionLink, siteLink };

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
  const [theme, setTheme] = useTheme();
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
              setTheme(nextTheme(theme));
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
            <SiteNavMenus current={current} go={go} />
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
      {/* The home and feature pages' bands run flush to the frame; other pages keep the gutter. */}
      <main
        id="site-main"
        className={
          page.page === 'home' || page.page === 'feature'
            ? 'site-main site-main-flush'
            : 'site-main'
        }
      >
        {children}
      </main>
      <SiteFooter navigate={go} />
    </div>
  );
}
