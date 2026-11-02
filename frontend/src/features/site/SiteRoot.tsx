// The public site's page switch, inside its own frame (no app sidebar), plus sign-in and
// sign-up (`/signin`, `/signup`), which hand over to the app once the session exists.
import { lazy, Suspense, useEffect, useState } from 'react';
import type { Session } from '../../hooks/useSession';
import { takeDeleted } from '../account-settings/deleteAccountModel';
import type { Navigate } from '../shell/useRoute';
import { SiteBlog } from './SiteBlog';
import { SiteFeaturePage } from './SiteFeaturePage';
import { SiteFeatures } from './SiteFeatures';
import { SiteHome } from './SiteHome';
import { SiteLayout } from './SiteLayout';
import { SiteCompany, SiteLegal } from './SitePages';
import { SitePricing } from './SitePricing';
import { SiteSignIn } from './SiteSignIn';
import { SiteUpdates, SiteUpdatesLink } from './SiteUpdates';
import { documentTitle } from './seo';
import { SIGNED_IN_HINT, type SitePage } from './siteRoute';

// The docs (their pages, search index and layout) load on the first docs visit; the page
// sets its own title.
const SiteDocs = lazy(() => import('./docs/SiteDocs').then((m) => ({ default: m.SiteDocs })));

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
  const tabTitle = documentTitle(site);
  // After the first paint, as the page is prerendered without it.
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    if (takeDeleted()) setDeleted(true);
  }, []);
  useEffect(() => {
    if (site.page !== 'docs') document.title = tabTitle;
  }, [site.page, tabTitle]);
  // A signed-in visitor has nothing to do on the sign-in page.
  const signedInOnSignIn = site.page === 'signin' && session.authenticated;
  useEffect(() => {
    if (signedInOnSignIn) navigate({ view: 'home' }, { replace: true });
  }, [signedInOnSignIn, navigate]);
  return (
    <SiteLayout page={site} authenticated={session.authenticated} navigate={navigate}>
      {deleted && (
        <p className="workspace-notice" role="status">
          Your account was deleted.
        </p>
      )}
      {site.page === 'home' && <SiteHome navigate={navigate} />}
      {site.page === 'features' && <SiteFeatures navigate={navigate} />}
      {site.page === 'feature' && (
        <SiteFeaturePage key={site.slug} slug={site.slug} navigate={navigate} />
      )}
      {site.page === 'pricing' && <SitePricing navigate={navigate} />}
      {site.page === 'docs' && (
        <Suspense fallback={<p className="docs-loading">Loading the docs…</p>}>
          <SiteDocs key={site.slug} slug={site.slug} navigate={navigate} />
        </Suspense>
      )}
      {site.page === 'blog' && <SiteBlog navigate={navigate} />}
      {site.page === 'post' && <SiteBlog slug={site.slug} navigate={navigate} />}
      {(site.page === 'about' || site.page === 'vision') && (
        <SiteCompany page={site.page} navigate={navigate} />
      )}
      {site.page === 'legal' && <SiteLegal doc={site.doc} navigate={navigate} />}
      {site.page === 'updates' && <SiteUpdates />}
      {site.page === 'updates-link' && (
        <SiteUpdatesLink action={site.action} token={site.token} navigate={navigate} />
      )}
      {site.page === 'signin' && (
        <SiteSignIn
          key={site.mode}
          mode={site.mode}
          error={signInError}
          onConnected={() => {
            signedInHint(true);
            void session.discover();
            navigate({ view: 'home' });
          }}
        />
      )}
    </SiteLayout>
  );
}
