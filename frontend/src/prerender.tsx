// The production build's server render of the public site (vite-prerender.ts): each page's
// markup as a signed-out visitor first sees it, so crawlers and link previews read real text
// without JavaScript. The browser app replaces it on start (createRoot, no hydration).
import { prerender } from 'react-dom/static';
import { SiteRoot } from './features/site/SiteRoot';
import { seoManifest } from './features/site/seo';
import { parseSitePath, type SitePage } from './features/site/siteRoute';
import type { Session } from './hooks/useSession';

export { seoManifest };

// SiteRoot reads only these two of the session; nothing runs effects on the server.
const signedOut = { authenticated: false, discover: async () => {} } as unknown as Session;

/** A site page's complete markup. */
export async function renderSitePage(path: string): Promise<string> {
  const site: SitePage | undefined =
    path === '/' ? { page: 'home' } : parseSitePath(path.split('/').filter(Boolean));
  if (!site) throw new Error(`Not a site page: ${path}`);
  // A large boundary (the docs) is otherwise outlined into a hidden segment that only a script
  // reveals; one unbounded chunk keeps every page's text in place.
  const { prelude } = await prerender(
    <SiteRoot site={site} session={signedOut} navigate={() => {}} />,
    { progressiveChunkSize: Number.POSITIVE_INFINITY },
  );
  return new Response(prelude).text();
}
