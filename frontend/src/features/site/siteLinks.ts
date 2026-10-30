// Links between the public site's pages, as anchor props: a real `href`, and a click that
// navigates inside the app instead of reloading.
import type { MouseEvent } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { formatSourceRoute, type SourceRoute } from '../source-platform/sourceRoute';
import type { SitePage } from './siteRoute';

export const siteLink = (page: SitePage, navigate: Navigate) =>
  linkTo({ view: 'site', site: page }, navigate);

/** A link to a section of a page: navigates in the app, then scrolls to `hash` once the page
 * has rendered. */
export function sectionLink(route: SourceRoute, hash: string, navigate: Navigate) {
  const href = `${formatSourceRoute(route)}#${hash}`;
  return {
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(route);
      window.history.replaceState(null, '', href);
      requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
    },
  };
}
