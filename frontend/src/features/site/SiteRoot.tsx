// The public site's page switch, inside its own frame (no app sidebar), plus sign-in and
// sign-up (`/signin`, `/signup`), which hand over to the app once the session exists.
import { useEffect } from 'react';
import type { Session } from '../../hooks/useSession';
import type { Navigate } from '../shell/useRoute';
import { AccountPanel } from '../workspace/AccountPanel';
import { BLOG_POSTS, COMPANY_PAGES, DOCS_PAGES, LEGAL_PAGES } from './content';
import { SiteFeatures } from './SiteFeatures';
import { SiteHome } from './SiteHome';
import { SiteLayout } from './SiteLayout';
import { SiteBlog, SiteCompany, SiteDocs, SiteLegal } from './SitePages';
import { SitePricing } from './SitePricing';
import { SIGNED_IN_HINT, type SitePage } from './siteRoute';

/** Remembers whether this browser is signed in (see `siteView`); storage may be blocked. */
export function signedInHint(value?: boolean): boolean {
  try {
    if (value === true) window.localStorage.setItem(SIGNED_IN_HINT, '1');
    else if (value === false) window.localStorage.removeItem(SIGNED_IN_HINT);
    return window.localStorage.getItem(SIGNED_IN_HINT) === '1';
  } catch {
    return false;
  }
}

function pageTitle(site: SitePage): string {
  switch (site.page) {
    case 'home':
      return 'YonedaRepo — source control for agents';
    case 'features':
      return 'Features';
    case 'pricing':
      return 'Pricing';
    case 'docs':
      return DOCS_PAGES[site.slug]?.title ?? 'Docs';
    case 'blog':
      return 'Blog';
    case 'post':
      return BLOG_POSTS.find((p) => p.slug === site.slug)?.title ?? 'Blog';
    case 'about':
    case 'vision':
      return COMPANY_PAGES[site.page].title;
    case 'legal':
      return LEGAL_PAGES[site.doc].title;
    case 'signin':
      return site.mode === 'login' ? 'Sign in' : 'Create your account';
  }
}

export function SiteRoot({
  site,
  session,
  navigate,
  signInError = '',
}: {
  site: SitePage;
  session: Session;
  navigate: Navigate;
  /** Why a provider sign-in came back refused (shown on the sign-in page). */
  signInError?: string;
}) {
  const title = pageTitle(site);
  useEffect(() => {
    document.title = site.page === 'home' ? title : `${title} — YonedaRepo`;
  }, [site.page, title]);
  // A signed-in visitor has nothing to do on the sign-in page.
  const signedInOnSignIn = site.page === 'signin' && session.authenticated;
  useEffect(() => {
    if (signedInOnSignIn) navigate({ view: 'home' }, { replace: true });
  }, [signedInOnSignIn, navigate]);
  return (
    <SiteLayout page={site} authenticated={session.authenticated} navigate={navigate}>
      {site.page === 'home' && <SiteHome navigate={navigate} />}
      {site.page === 'features' && <SiteFeatures navigate={navigate} />}
      {site.page === 'pricing' && <SitePricing navigate={navigate} />}
      {site.page === 'docs' && <SiteDocs key={site.slug} slug={site.slug} navigate={navigate} />}
      {site.page === 'blog' && <SiteBlog navigate={navigate} />}
      {site.page === 'post' && <SiteBlog slug={site.slug} navigate={navigate} />}
      {(site.page === 'about' || site.page === 'vision') && (
        <SiteCompany page={site.page} navigate={navigate} />
      )}
      {site.page === 'legal' && <SiteLegal doc={site.doc} navigate={navigate} />}
      {site.page === 'signin' && (
        <section className="site-signin" aria-labelledby="signin-heading">
          <h1 id="signin-heading">{title}</h1>
          <AccountPanel
            key={site.mode}
            initialMode={site.mode}
            initialError={signInError}
            onConnected={() => {
              signedInHint(true);
              void session.discover();
              navigate({ view: 'home' });
            }}
          />
        </section>
      )}
    </SiteLayout>
  );
}
