// The readable addresses both Workers route (repo-paths resolves them): Git over HTTPS at
// `/<handle>/<name>.git` (served by the platform Worker; the front Worker passes it on), and
// the old `/source/<id>[/...]` pages, which move for good to `/<handle>/<name>[/...]` for
// anyone who may read the repository (anyone else gets the app, as before, which finds
// nothing). Kept free of imports: the front Worker routes with it too.

/** The handle, the name and the Git action of a readable Git path. */
export const GIT_PATH =
  /^\/([A-Za-z][A-Za-z0-9_]{2,31})\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,99}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const LEGACY = /^\/source\/(r[0-9a-f]{20})(\/[^?#]*)?$/;

/**
 * A page at its old address (`/source/<id>[/...]`) answers 301 to its readable path, when
 * `ask` (the platform's `GET /api/v1/repos/<id>/path`, with the request's credentials)
 * finds the caller may read it; null otherwise (the page is served as before). The answer
 * depends on who asks, so it is never stored.
 */
export async function legacyRedirect(
  req: Request,
  ask: (path: Request) => Promise<Response>,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  const legacy = LEGACY.exec(url.pathname);
  if (!legacy) return null;
  const headers = new Headers();
  for (const name of ['cookie', 'authorization'])
    if (req.headers.has(name)) headers.set(name, req.headers.get(name) ?? '');
  const answer = await ask(
    new Request(new URL(`/api/v1/repos/${legacy[1]}/path`, url), { headers }),
  );
  if (!answer.ok) return null;
  const { path } = await answer.json<{ path: string }>();
  const location = `${path}${legacy[2] ?? ''}${url.search}`;
  return new Response(null, {
    status: 301,
    headers: { location, 'cache-control': 'private, no-store', vary: 'cookie, authorization' },
  });
}
