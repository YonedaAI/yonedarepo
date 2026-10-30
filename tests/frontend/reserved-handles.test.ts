// Every top-level path the site, the app or the Workers route is a reserved handle: `/<handle>`
// is a profile and `/<handle>/<repository>` a repository, so a handle equal to a page's name
// would shadow it (or it the profile). A new top-level page, route or public folder fails
// here until its name joins `yoneda_core::account::RESERVED_HANDLES` (`cargo xtask contracts`
// then regenerates `shared/contracts/reserved-handles.ts`).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_HANDLES } from '../../shared/account';
import { parseSitePath } from '../../frontend/src/features/site/siteRoute';
import { parseSourceRoute } from '../../frontend/src/features/source-platform/sourceRoute';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string) => readFileSync(root(path), 'utf8');
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/;

/** Handle-shaped string literals in a file: the names its routes compare segments with. */
const literals = (path: string) =>
  [...source(path).matchAll(/['"`]([a-z][a-z0-9_]{2,31})['"`]/g)].map((m) => m[1]);

/** The first path segments of `'/…'` literals in a Worker's router. */
const workerRoots = (path: string) =>
  [...source(path).matchAll(/['"`]\/([a-z][a-z0-9_-]*)/g)].map((m) => m[1]).filter((s) => HANDLE.test(s));

const REPO = 'r00000000000000000000';
/** What the app makes of a path nothing else claims: home, or a handle's profile and one of
 * its repositories (`/<handle>[/<name>]`). */
const OPEN = ['home', 'profile', 'repo-name'];
/** Whether the app routes `/<segment>` (alone, or with something after it) to a page of its
 * own rather than to what any handle gets. */
const appRoutes = (segment: string) =>
  [[segment], [segment, 'x']].some((parts) => parseSitePath(parts) !== undefined) ||
  [`/${segment}`, `/${segment}/x`, `/${segment}/${REPO}`].some(
    (path) => !OPEN.includes(parseSourceRoute(path, '').view),
  );

describe('reserved handles', () => {
  it('cover every top-level page the app routes', () => {
    const routed = new Set(
      [
        ...literals('frontend/src/features/site/siteRoute.ts'),
        ...literals('frontend/src/features/source-platform/sourceRoute.ts'),
      ].filter(appRoutes),
    );
    expect(routed.size).toBeGreaterThan(10);
    expect([...routed].filter((name) => !RESERVED_HANDLES.has(name))).toEqual([]);
  });

  it("cover the Workers' own paths and the site's public folders", () => {
    const paths = [
      ...workerRoots('cloudflare/worker/front-routes.ts'),
      ...workerRoots('cloudflare/worker/platform-routes.ts'),
      ...readdirSync(root('frontend/public')).filter((name) => HANDLE.test(name)),
      // Vite's build output folder for hashed scripts and styles.
      'assets',
    ];
    expect(paths).toEqual(expect.arrayContaining(['api', 'git', 'health', 'source', 'brand']));
    expect([...new Set(paths)].filter((name) => !RESERVED_HANDLES.has(name))).toEqual([]);
  });

  it('are handle-shaped and sorted, so they match the Rust list one for one', () => {
    const list = [...RESERVED_HANDLES];
    expect(list.every((name) => HANDLE.test(name))).toBe(true);
    expect(list).toEqual([...list].sort());
  });
});
