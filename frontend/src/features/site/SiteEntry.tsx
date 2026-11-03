// Public pages are independent of the workspace entry and its repository reads.
import { type ComponentProps, lazy, Suspense } from 'react';
import { Loading } from '../source-platform/SourceStatus';
import { parseSitePath } from './siteRoute';

type Module = typeof import('./SiteRoot');
type Props = ComponentProps<Module['SiteRoot']>;
let loaded: Module | undefined;
let loading: Promise<Module> | undefined;

export function loadSiteRoot() {
  loading ??= import('./SiteRoot').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}
const LazySite = lazy(() => loadSiteRoot().then((module) => ({ default: module.SiteRoot })));

/** Preserve initial public prerendered HTML until its client component is ready. */
export function prepareSiteEntry(pathname: string, signedIn: boolean) {
  const publicPage =
    pathname === '/' ? !signedIn : Boolean(parseSitePath(pathname.split('/').filter(Boolean)));
  return publicPage ? loadSiteRoot().then(() => {}) : undefined;
}

export function SiteEntry(props: Props) {
  if (loaded) return <loaded.SiteRoot {...props} />;
  return (
    <Suspense fallback={<Loading what="page" />}>
      <LazySite {...props} />
    </Suspense>
  );
}
