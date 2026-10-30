import { useCallback, useEffect, useState } from 'react';
import {
  formatSourceRoute,
  parseSourceRoute,
  type SourceRoute,
} from '../source-platform/sourceRoute';

const current = (): SourceRoute =>
  typeof window === 'undefined'
    ? { view: 'home' }
    : parseSourceRoute(window.location.pathname, window.location.search, window.location.hash);

export type Navigate = (next: SourceRoute, options?: { replace?: boolean }) => void;

/**
 * The shell's address: parsed from the URL, pushed on navigation and followed on back and
 * forward. An older address (`/source/tokens`, `/source/<repo>/connect`, `/settings#billing`)
 * is rewritten to the page that replaced it, so a reload lands on the current URL.
 */
export function useRoute(): [SourceRoute, Navigate] {
  const [route, setRoute] = useState<SourceRoute>(current);
  useEffect(() => {
    const sync = () => setRoute(current());
    window.addEventListener('popstate', sync);
    const parsed = current();
    // Home keeps its query: the workspace's `?repo=&run=` link is read from it.
    if (parsed.view !== 'home') {
      const canonical = formatSourceRoute(parsed);
      if (canonical !== `${window.location.pathname}${window.location.search}`)
        window.history.replaceState(null, '', canonical);
    }
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const navigate = useCallback<Navigate>((next, options) => {
    const url = formatSourceRoute(next);
    if (options?.replace) window.history.replaceState(null, '', url);
    else {
      window.history.pushState(null, '', url);
      window.scrollTo({ top: 0 });
    }
    setRoute(next);
  }, []);
  return [route, navigate];
}

/** Puts `route`'s current address in the location bar (a repository's readable address once
 * its name is known), without a new history entry. */
export function showAddress(route: SourceRoute) {
  const url = formatSourceRoute(route);
  if (url !== `${window.location.pathname}${window.location.search}`)
    window.history.replaceState(null, '', url);
}

/** Props for an in-app link: a real `href` (new tab, copy link) and client navigation. */
export function linkTo(route: SourceRoute, navigate: Navigate) {
  return {
    href: formatSourceRoute(route),
    onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(route);
    },
  };
}
